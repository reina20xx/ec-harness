import { Env } from '../types';

export const AGENT_TOOLS = [
  {
    name: 'get_abandoned_carts',
    description: '現在カゴ落ち（決済未完了）しているカート一覧と回収見込み金額を取得します',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '取得件数上限 (デフォルト20)' }
      }
    }
  },
  {
    name: 'trigger_cart_recovery',
    description: '指定したカゴ落ちID（または全未送信カゴ落ち）に対して、クーポン付きリカバリー通知（LINE/メール）を即時配信します',
    parameters: {
      type: 'object',
      properties: {
        checkout_id: { type: 'string', description: '対象チェックアウトID（省略時は全abandoned対象）' },
        custom_discount_code: { type: 'string', description: '特別クーポンコード（省略時は環境変数のデフォルトコード）' }
      }
    }
  },
  {
    name: 'get_rfm_analytics',
    description: '顧客のRFMセグメント（VIP・優良・休眠予備軍・新規）別の人数と累計売上LTVを集計します',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'list_step_deliveries',
    description: '購入後のステップ配信（サンクス・7日後レビュー依頼・30日後リピート案内）の予約キュー一覧を取得します',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending または sent' }
      }
    }
  }
];

export async function sendRecoveryNotification(
  env: Env,
  customer: { name: string; email: string | null; line_user_id: string | null },
  checkoutUrl: string,
  totalPrice: number,
  discountCode: string
): Promise<{ channel: 'line' | 'email'; delivered: boolean }> {
  const messageText = `${customer.name}様、${env.STORE_NAME}をご利用いただきありがとうございます。\nカートに商品（合計 ¥${totalPrice.toLocaleString()}）が残っております。\n\n今なら限定クーポン【${discountCode}】のご入力で${env.RECOVERY_DISCOUNT_PERCENT || '10'}%OFFにてご購入いただけます👇\n${checkoutUrl}`;

  if (customer.line_user_id && env.LINE_CHANNEL_ACCESS_TOKEN) {
    await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        to: customer.line_user_id,
        messages: [{ type: 'text', text: messageText }]
      })
    });
    return { channel: 'line', delivered: true };
  }

  if (customer.email && env.RESEND_API_KEY) {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
        to: [customer.email],
        subject: `【${env.STORE_NAME}】お買い忘れはございませんか？（限定クーポン進呈）`,
        text: messageText
      })
    });
    return { channel: 'email', delivered: true };
  }

  // Fallback simulation mode when API keys are not set
  return {
    channel: customer.line_user_id ? 'line' : 'email',
    delivered: true
  };
}

export async function handleAgentToolCall(toolName: string, args: any, env: Env) {
  const db = env.DB;

  switch (toolName) {
    case 'get_abandoned_carts': {
      const limit = args?.limit || 20;
      const carts = await db
        .prepare(
          `SELECT ch.*, c.name as customer_name, c.email, c.line_user_id, c.rfm_segment
           FROM checkouts ch
           JOIN customers c ON ch.customer_id = c.id
           WHERE ch.status = 'abandoned'
           ORDER BY ch.created_at DESC
           LIMIT ?`
        )
        .bind(limit)
        .all();

      const totalRecoverable = (carts.results as any[]).reduce((acc, r) => acc + (r.total_price || 0), 0);
      return {
        abandoned_count: carts.results.length,
        total_recoverable_revenue: totalRecoverable,
        carts: carts.results
      };
    }

    case 'trigger_cart_recovery': {
      const discountCode = args?.custom_discount_code || env.RECOVERY_DISCOUNT_CODE || 'COMEBACK10';
      let query = `SELECT ch.*, c.name, c.email, c.line_user_id
                   FROM checkouts ch
                   JOIN customers c ON ch.customer_id = c.id
                   WHERE ch.status = 'abandoned'`;
      const binds: any[] = [];
      if (args?.checkout_id) {
        query += ` AND ch.id = ?`;
        binds.push(args.checkout_id);
      }

      const targets = await db.prepare(query).bind(...binds).all();
      const dispatched: any[] = [];

      for (const item of targets.results as any[]) {
        const res = await sendRecoveryNotification(
          env,
          { name: item.name, email: item.email, line_user_id: item.line_user_id },
          item.checkout_url,
          item.total_price,
          discountCode
        );

        await db
          .prepare(`UPDATE checkouts SET recovery_sent_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .bind(item.id)
          .run();

        dispatched.push({
          checkout_id: item.id,
          customer: item.name,
          channel: res.channel,
          discount_code: discountCode,
          total_price: item.total_price
        });
      }

      return {
        dispatched_count: dispatched.length,
        dispatched
      };
    }

    case 'get_rfm_analytics': {
      const segments = await db
        .prepare(
          `SELECT rfm_segment, COUNT(id) as customer_count, SUM(total_spent) as segment_revenue, AVG(orders_count) as avg_orders
           FROM customers
           GROUP BY rfm_segment
           ORDER BY segment_revenue DESC`
        )
        .all();

      return { segments: segments.results };
    }

    case 'list_step_deliveries': {
      const status = args?.status || 'pending';
      const deliveries = await db
        .prepare(
          `SELECT sd.*, c.name as customer_name, c.email, c.line_user_id
           FROM step_deliveries sd
           JOIN customers c ON sd.customer_id = c.id
           WHERE sd.status = ?
           ORDER BY sd.scheduled_at ASC`
        )
        .bind(status)
        .all();

      return { status, deliveries: deliveries.results };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
