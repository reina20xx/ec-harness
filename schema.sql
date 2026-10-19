-- EC Harness: D1 Database Schema
-- Abandoned Cart Recovery, Post-Purchase Step Sequences & RFM Segmentation

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  line_user_id TEXT UNIQUE,
  name TEXT NOT NULL,
  total_spent INTEGER NOT NULL DEFAULT 0,
  orders_count INTEGER NOT NULL DEFAULT 0,
  last_order_at DATETIME,
  rfm_segment TEXT NOT NULL DEFAULT 'new', -- 'vip', 'loyal', 'promising', 'at_risk', 'new'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS checkouts (
  id TEXT PRIMARY KEY,
  external_checkout_id TEXT UNIQUE,
  customer_id TEXT NOT NULL,
  cart_items_json TEXT NOT NULL,
  total_price INTEGER NOT NULL DEFAULT 0,
  checkout_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'abandoned', 'recovered', 'completed')) DEFAULT 'open',
  recovery_sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  external_order_id TEXT UNIQUE,
  customer_id TEXT NOT NULL,
  checkout_id TEXT,
  items_json TEXT NOT NULL,
  total_price INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS step_deliveries (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  order_id TEXT,
  step_type TEXT NOT NULL CHECK(step_type IN ('abandoned_cart_1h', 'thank_you', 'review_request_7d', 'reorder_30d')),
  channel TEXT NOT NULL CHECK(channel IN ('line', 'email')) DEFAULT 'email',
  scheduled_at DATETIME NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'cancelled')) DEFAULT 'pending',
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_checkouts_status ON checkouts(status);
CREATE INDEX IF NOT EXISTS idx_customers_segment ON customers(rfm_segment);
CREATE INDEX IF NOT EXISTS idx_step_deliveries_status ON step_deliveries(status, scheduled_at);

-- Seed Data for Immediate Demo & Testing
INSERT OR IGNORE INTO customers (id, email, line_user_id, name, total_spent, orders_count, last_order_at, rfm_segment) VALUES
('cust_vip_01', 'sato@example.com', 'U_line_sato_01', '佐藤 美咲', 84500, 7, '2026-10-15 14:20:00', 'vip'),
('cust_loyal_02', 'suzuki@example.com', 'U_line_suzuki_02', '鈴木 健太', 32000, 3, '2026-10-01 19:00:00', 'loyal'),
('cust_risk_03', 'takahashi@example.com', NULL, '高橋 優子', 12800, 2, '2026-06-10 11:30:00', 'at_risk'),
('cust_abandon_04', 'tanaka@example.com', 'U_line_tanaka_04', '田中 翔太', 0, 0, NULL, 'new');

INSERT OR IGNORE INTO checkouts (id, external_checkout_id, customer_id, cart_items_json, total_price, checkout_url, status, created_at) VALUES
('chk_01', 'shpfy_chk_9901', 'cust_abandon_04', '[{"title":"オーガニック導入美容液 50ml","qty":1,"price":6800},{"title":"モイスチャーローション","qty":1,"price":4200}]', 11000, 'https://store.example.com/checkouts/shpfy_chk_9901', 'abandoned', '2026-10-19 10:00:00'),
('chk_02', 'shpfy_chk_9902', 'cust_risk_03', '[{"title":"エイジングケア ナイトクリーム","qty":1,"price":9800}]', 9800, 'https://store.example.com/checkouts/shpfy_chk_9902', 'abandoned', '2026-10-19 12:30:00');
