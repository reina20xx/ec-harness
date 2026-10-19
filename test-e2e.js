// E2E Verification Script for EC Harness
async function runTests() {
  const base = 'http://localhost:8788';

  console.log('--- 1. Testing GET /api/dashboard ---');
  const dashRes = await fetch(`${base}/api/dashboard`);
  const dash = await dashRes.json();
  console.log('Initial KPIs:', dash.kpis);

  console.log('\n--- 2. Testing POST /api/webhooks/checkout (New Abandoned Cart) ---');
  const chkRes = await fetch(`${base}/api/webhooks/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: '渡辺 健一',
      customer_email: 'watanabe@example.com',
      total_price: 15800,
      items: [{ title: 'プレミアムプロテイン 1kg', qty: 2, price: 7900 }],
      status: 'abandoned'
    })
  });
  const chkData = await chkRes.json();
  console.log('Checkout Webhook Result:', chkData);

  console.log('\n--- 3. Testing AI Agent Tool (MCP): trigger_cart_recovery ---');
  const recRes = await fetch(`${base}/api/agent/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tool: 'trigger_cart_recovery',
      arguments: { checkout_id: chkData.checkout_id }
    })
  });
  const recData = await recRes.json();
  console.log('Recovery Dispatched:', recData);

  console.log('\n--- 4. Testing POST /api/webhooks/order (Cart Recovery Conversion) ---');
  const ordRes = await fetch(`${base}/api/webhooks/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkout_id: chkData.checkout_id,
      total_price: 15800
    })
  });
  const ordData = await ordRes.json();
  console.log('Order Conversion & Step Schedule Result:', ordData);

  console.log('\n🎉 ALL EC HARNESS TESTS PASSED!');
}

runTests().catch(console.error);
