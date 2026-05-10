-- 监控的代币列表
CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,           -- CA
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    -- Birdeye 拉到的元数据
    fdv_usd REAL,
    lp_usd REAL,
    holders INTEGER,
    age_seconds INTEGER,                -- 从代币创建到加入监控的存在时间
    created_at_unix INTEGER,            -- 代币首次创建时间（链上）
    -- 价格相关
    price_usd REAL,
    price_sol REAL,
    high_24h REAL,                      -- 滚动 24h 内见过的最高价（USD）
    high_24h_at INTEGER,                -- 该最高价的时间戳
    volume_24h_usd REAL,
    -- 反推 24h 高点的辅助字段：来自 Birdeye token_overview
    history_2h_price REAL,
    history_6h_price REAL,
    history_24h_price REAL,
    -- X mentions（已废弃但保留兼容）
    x_mentions_60m INTEGER DEFAULT 0,
    x_engagement_avg REAL DEFAULT 0,
    x_heat_score REAL DEFAULT 0,
    x_last_query_at INTEGER,
    -- 状态
    monitor_active INTEGER NOT NULL DEFAULT 1,  -- 0=已移除
    added_at INTEGER NOT NULL,
    added_by TEXT,                      -- 'manual' / 'webhook'
    last_alert_at INTEGER,              -- 上次报警时间，用于冷却
    last_metadata_refresh_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tokens_active ON tokens(monitor_active);

-- 持仓
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    amount_raw TEXT NOT NULL,           -- 原始数量（最小单位字符串，避免精度丢失）
    amount_ui REAL NOT NULL,            -- UI 数量
    avg_entry_price_usd REAL NOT NULL,
    avg_entry_price_sol REAL NOT NULL,
    sol_spent REAL NOT NULL,            -- 累计花的 SOL（含 gas）
    realized_pnl_sol REAL NOT NULL DEFAULT 0,
    is_open INTEGER NOT NULL DEFAULT 1,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    auto_take_profit_active INTEGER NOT NULL DEFAULT 1,
    -- 自动逢低买入：上一次买入价（USD），用于 DCA 判定
    last_buy_price_usd REAL,
    -- 此仓位累计买入次数（含 DCA），用于限制最多 DCA 次数
    buy_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE INDEX IF NOT EXISTS idx_positions_open ON positions(is_open);
CREATE INDEX IF NOT EXISTS idx_positions_token ON positions(token_address);

-- 交易记录
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    side TEXT NOT NULL,                 -- 'buy' | 'sell'
    trigger TEXT NOT NULL,              -- 'manual' | 'auto_take_profit' | 'auto_remove_sell'
    -- 输入/输出（按 swap 视角）
    in_mint TEXT NOT NULL,
    out_mint TEXT NOT NULL,
    in_amount_raw TEXT NOT NULL,
    out_amount_raw TEXT NOT NULL,
    in_amount_ui REAL NOT NULL,
    out_amount_ui REAL NOT NULL,
    -- 价格快照
    price_usd_at_trade REAL,
    sol_price_usd_at_trade REAL,
    -- 链上信息
    tx_signature TEXT,
    status TEXT NOT NULL,               -- 'pending' | 'success' | 'failed'
    error_msg TEXT,
    slippage_bps INTEGER,
    priority_fee_lamports INTEGER,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    realized_pnl_sol REAL,              -- 仅 sell 有意义：本次卖出的已实现盈亏（SOL）
    FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token_address);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- 报警历史（避免重复报、便于审计）
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_address TEXT NOT NULL,
    type TEXT NOT NULL,                 -- 'drop_50pct' | 'auto_remove' | 'take_profit' | ...
    payload_json TEXT,
    sent_at INTEGER NOT NULL,
    success INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(token_address);
CREATE INDEX IF NOT EXISTS idx_alerts_sent ON alerts(sent_at DESC);

-- X API 用量（按 UTC 日聚合，做预算控制）
CREATE TABLE IF NOT EXISTS x_api_usage (
    day TEXT PRIMARY KEY,               -- 'YYYY-MM-DD'
    reads INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
);

-- X 帖子去重缓存（同一帖 24h 内只算一次）
CREATE TABLE IF NOT EXISTS x_post_cache (
    post_id TEXT PRIMARY KEY,
    token_address TEXT,
    fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_post_token ON x_post_cache(token_address);
CREATE INDEX IF NOT EXISTS idx_x_post_fetched ON x_post_cache(fetched_at);

-- 价格历史（用于 24h 滚动高点修正、PnL 图表）
-- 用细粒度但保留 7 天；定期清理
CREATE TABLE IF NOT EXISTS price_history (
    token_address TEXT NOT NULL,
    ts INTEGER NOT NULL,                -- unix seconds
    price_usd REAL NOT NULL,
    PRIMARY KEY (token_address, ts)
);

CREATE INDEX IF NOT EXISTS idx_price_history_ts ON price_history(ts);

-- 元数据
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
