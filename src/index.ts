import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { AGENT_TOOLS, handleAgentToolCall, sendRecoveryNotification } from './agent/mcp';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'ec-harness', timestamp: new Date().toISOString() });
});

// Dashboard KPIs & Overview
app.get('/api/dashboard', async (c) => {
  const db = c.env.DB;

  const checkouts = await db
    .prepare(
      `SELECT ch.*, c.name as customer_name, c.email, c.line_user_id, c.rfm_segment
       FROM checkouts ch
       JOIN customers c ON ch.customer_id = c.id
       ORDER BY ch.created_at DESC
       LIMIT 20`
    )
    .all();

  const segments = await db
    .prepare(
      `SELECT rfm_segment, COUNT(id) as count, COALESCE(SUM(total_spent), 0) as revenue
       FROM customers
       GROUP BY rfm_segment`
    )
    .all();

  const steps = await db
    .prepare(
      `SELECT sd.*, c.name as customer_name
       FROM step_deliveries sd
       JOIN customers c ON sd.customer_id = c.id
       ORDER BY sd.scheduled_at ASC
       LIMIT 20`
    )
    .all();

  const abandonedList = (checkouts.results as any[]).filter((x) => x.status === 'abandoned');
  const recoveredList = (checkouts.results as any[]).filter((x) => x.status === 'recovered');

  return c.json({
    store_name: c.env.STORE_NAME || 'Harness D2C Store',
    kpis: {
      abandoned_count: abandonedList.length,
      recoverable_revenue: abandonedList.reduce((s, x) => s + (x.total_price || 0), 0),
      recovered_count: recoveredList.length,
      recovered_revenue: recoveredList.reduce((s, x) => s + (x.total_price || 0), 0)
    },
    checkouts: checkouts.results,
    segments: segments.results,
    step_deliveries: steps.results
  });
});

// Webhook: Checkout Created / Updated (Shopify / BASE / Custom EC)
app.post('/api/webhooks/checkout', async (c) => {
  const body = await c.req.json();
  const {
    external_checkout_id,
    customer_name,
    customer_email,
    line_user_id,
    items,
    total_price,
    checkout_url,
    status = 'abandoned'
  } = body;

  if (!customer_name || !total_price) {
    return c.json({ error: 'customer_name and total_price are required' }, 400);
  }

  const db = c.env.DB;
  let customerId = `cust_${crypto.randomUUID().slice(0, 8)}`;

  if (customer_email) {
    const existing = await db
      .prepare('SELECT id FROM customers WHERE email = ?')
      .bind(customer_email)
      .first<{ id: string }>();
    if (existing) customerId = existing.id;
    else {
      await db
        .prepare('INSERT INTO customers (id, email, line_user_id, name) VALUES (?, ?, ?, ?)')
        .bind(customerId, customer_email, line_user_id || null, customer_name)
        .run();
    }
  } else {
    await db
      .prepare('INSERT INTO customers (id, line_user_id, name) VALUES (?, ?, ?)')
      .bind(customerId, line_user_id || null, customer_name)
      .run();
  }

  const checkoutId = `chk_${crypto.randomUUID().slice(0, 8)}`;
  const extId = external_checkout_id || `ext_${checkoutId}`;

  await db
    .prepare(
      `INSERT INTO checkouts (id, external_checkout_id, customer_id, cart_items_json, total_price, checkout_url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      checkoutId,
      extId,
      customerId,
      JSON.stringify(items || [{ title: 'D2C スターターセット', qty: 1, price: total_price }]),
      total_price,
      checkout_url || `https://store.example.com/checkouts/${extId}`,
      status
    )
    .run();

  return c.json({
    success: true,
    checkout_id: checkoutId,
    customer_id: customerId,
    status
  });
});

// Webhook: Order Completed (Converts Abandoned Cart & Schedules Step Emails/LINE)
app.post('/api/webhooks/order', async (c) => {
  const body = await c.req.json();
  const { checkout_id, customer_email, customer_name, total_price, items } = body;

  const db = c.env.DB;
  let customerId: string | null = null;
  let wasRecovered = false;

  if (checkout_id) {
    const chk = await db
      .prepare('SELECT * FROM checkouts WHERE id = ? OR external_checkout_id = ?')
      .bind(checkout_id, checkout_id)
      .first<any>();

    if (chk) {
      customerId = chk.customer_id;
      wasRecovered = !!chk.recovery_sent_at || chk.status === 'abandoned';
      const newStatus = wasRecovered ? 'recovered' : 'completed';
      await db
        .prepare('UPDATE checkouts SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(newStatus, chk.id)
        .run();
    }
  }

  if (!customerId && customer_email) {
    const existing = await db
      .prepare('SELECT id FROM customers WHERE email = ?')
      .bind(customer_email)
      .first<{ id: string }>();
    if (existing) customerId = existing.id;
  }

  if (!customerId) {
    customerId = `cust_${crypto.randomUUID().slice(0, 8)}`;
    await db
      .prepare('INSERT INTO customers (id, email, name) VALUES (?, ?, ?)')
      .bind(customerId, customer_email || null, customer_name || 'ゲスト購入者')
      .run();
  }

  // Update Customer LTV & RFM Segment
  const cust = await db
    .prepare('SELECT total_spent, orders_count, line_user_id FROM customers WHERE id = ?')
    .bind(customerId)
    .first<{ total_spent: number; orders_count: number; line_user_id: string | null }>();

  const newSpent = (cust?.total_spent || 0) + (total_price || 0);
  const newCount = (cust?.orders_count || 0) + 1;
  const newSegment = newSpent >= 50000 || newCount >= 5 ? 'vip' : newCount >= 2 ? 'loyal' : 'promising';

  await db
    .prepare(
      `UPDATE customers 
       SET total_spent = ?, orders_count = ?, last_order_at = CURRENT_TIMESTAMP, rfm_segment = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    )
    .bind(newSpent, newCount, newSegment, customerId)
    .run();

  const orderId = `ord_${crypto.randomUUID().slice(0, 8)}`;
  await db
    .prepare(
      `INSERT INTO orders (id, external_order_id, customer_id, checkout_id, items_json, total_price)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(orderId, `ext_${orderId}`, customerId, checkout_id || null, JSON.stringify(items || []), total_price || 0)
    .run();

  // Schedule Post-Purchase Step Sequence (Thank You, 7d Review, 30d Reorder)
  const channel = cust?.line_user_id ? 'line' : 'email';
  const now = Date.now();
  const d7 = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
  const d30 = new Date(now + 30 * 24 * 3600 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO step_deliveries (id, customer_id, order_id, step_type, channel, scheduled_at, status)
       VALUES (?, ?, ?, 'thank_you', ?, CURRENT_TIMESTAMP, 'sent'),
              (?, ?, ?, 'review_request_7d', ?, ?, 'pending'),
              (?, ?, ?, 'reorder_30d', ?, ?, 'pending')`
    )
    .bind(
      `stp_${crypto.randomUUID().slice(0, 8)}`, customerId, orderId, channel,
      `stp_${crypto.randomUUID().slice(0, 8)}`, customerId, orderId, channel, d7,
      `stp_${crypto.randomUUID().slice(0, 8)}`, customerId, orderId, channel, d30
    )
    .run();

  return c.json({
    success: true,
    order_id: orderId,
    recovered_cart: wasRecovered,
    new_rfm_segment: newSegment,
    scheduled_steps: ['thank_you (sent)', 'review_request_7d (pending)', 'reorder_30d (pending)']
  });
});

// Trigger Recovery for a Specific Checkout
app.post('/api/recover/:checkoutId', async (c) => {
  const checkoutId = c.req.param('checkoutId');
  const result = await handleAgentToolCall('trigger_cart_recovery', { checkout_id: checkoutId }, c.env);
  return c.json({ success: true, ...result });
});

// AI Agent MCP Endpoints
app.get('/api/agent/tools', (c) => c.json({ tools: AGENT_TOOLS }));

app.post('/api/agent/call', async (c) => {
  const { tool, arguments: args } = await c.req.json();
  try {
    const result = await handleAgentToolCall(tool, args, c.env);
    return c.json({ success: true, result });
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500);
  }
});

export default app;
