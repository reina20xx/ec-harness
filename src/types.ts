export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  STORE_NAME: string;
  RECOVERY_DISCOUNT_CODE: string;
  RECOVERY_DISCOUNT_PERCENT: string;
  ABANDON_THRESHOLD_MINUTES: string;

  // Optional Messaging & Email Credentials
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  SHOPIFY_WEBHOOK_SECRET?: string;

  // Agent API Key
  AGENT_API_KEY?: string;
}

export interface CartItem {
  title: string;
  qty: number;
  price: number;
}
