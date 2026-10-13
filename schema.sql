-- ============================================================
-- PESTOCKS · Database schema (SQLite / Cloudflare D1)
-- Rigid data layer: 1:1 profile & balance rows, composite-key
-- holdings, immutable trade ledger, matching-optimized indexes.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Accounts & credentials ----------
CREATE TABLE IF NOT EXISTS users (
    user_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username              TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash         TEXT    NOT NULL,
    password_salt         TEXT    NOT NULL,
    secret_question       TEXT    NOT NULL,   -- plain-text question (returned to user on recovery)
    secret_answer_hash    TEXT    NOT NULL,   -- hash of client-side SHA-256 digest
    backup_pin_hash       TEXT    NOT NULL,   -- hash of client-side SHA-256 digest
    recovery_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
    last_recovery_attempt INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------- Sessions (bearer tokens) ----------
CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------- One-time password-reset tokens ----------
CREATE TABLE IF NOT EXISTS recovery_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    used       INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1)),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER NOT NULL
);

-- ---------- Progression (strict 1:1 with users) ----------
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id          INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    level            INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 50),
    exp              INTEGER NOT NULL DEFAULT 0 CHECK (exp >= 0),
    daily_exp_earned INTEGER NOT NULL DEFAULT 0,
    daily_exp_date   TEXT    NOT NULL DEFAULT '',
    wins             INTEGER NOT NULL DEFAULT 0,
    losses           INTEGER NOT NULL DEFAULT 0,
    realized_pnl     REAL    NOT NULL DEFAULT 0,
    holding_seconds  INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------- Funds (strict 1:1 with users) ----------
CREATE TABLE IF NOT EXISTS user_balances (
    user_id       INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    cash          REAL NOT NULL DEFAULT 100000 CHECK (cash >= 0),
    locked_margin REAL NOT NULL DEFAULT 0 CHECK (locked_margin >= 0),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------- Market instruments ----------
CREATE TABLE IF NOT EXISTS market_state (
    ticker      TEXT PRIMARY KEY,
    asset_class TEXT NOT NULL CHECK (asset_class IN ('STOCK','FOREX','REALESTATE')),
    name        TEXT NOT NULL,
    price       REAL NOT NULL CHECK (price > 0),
    base_price  REAL NOT NULL,
    volatility  REAL NOT NULL,
    drift       REAL NOT NULL DEFAULT 0,
    dividend    REAL NOT NULL DEFAULT 0,   -- annual yield for dividend-paying stocks
    last_bucket INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------- Positions: composite PK forces ONE row per (user, asset) ----------
CREATE TABLE IF NOT EXISTS asset_holdings (
    user_id         INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    asset_ticker    TEXT    NOT NULL REFERENCES market_state(ticker),
    direction       TEXT    NOT NULL DEFAULT 'LONG' CHECK (direction IN ('LONG','SHORT')),
    quantity        REAL    NOT NULL CHECK (quantity >= 0),
    avg_entry_price REAL    NOT NULL CHECK (avg_entry_price > 0),
    leverage        REAL    NOT NULL DEFAULT 1 CHECK (leverage >= 1),
    margin_used     REAL    NOT NULL DEFAULT 0 CHECK (margin_used >= 0),
    opened_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, asset_ticker)
);

-- ---------- Resting orders (Limit / Stop-Loss) ----------
CREATE TABLE IF NOT EXISTS pending_orders (
    order_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    asset_ticker  TEXT    NOT NULL REFERENCES market_state(ticker),
    side          TEXT    NOT NULL CHECK (side IN ('BUY','SELL')),
    order_type    TEXT    NOT NULL CHECK (order_type IN ('LIMIT','STOP_LOSS')),
    trigger_price REAL    NOT NULL CHECK (trigger_price > 0),
    quantity      REAL    NOT NULL CHECK (quantity > 0),
    leverage      REAL    NOT NULL DEFAULT 1,
    status        TEXT    NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED','CANCELLED')),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    resolved_at   INTEGER
);

-- ---------- Immutable trade ledger ----------
CREATE TABLE IF NOT EXISTS trade_history (
    trade_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    asset_ticker TEXT    NOT NULL,
    side         TEXT    NOT NULL CHECK (side IN ('BUY','SELL')),
    order_type   TEXT    NOT NULL,
    quantity     REAL    NOT NULL,
    price        REAL    NOT NULL,
    leverage     REAL    NOT NULL DEFAULT 1,
    fee          REAL    NOT NULL DEFAULT 0,
    pnl          REAL    NOT NULL DEFAULT 0,
    executed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- ---------- High-performance indexing ----------
CREATE INDEX IF NOT EXISTS idx_pending_match  ON pending_orders (asset_ticker, status, trigger_price);
CREATE INDEX IF NOT EXISTS idx_pending_user   ON pending_orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_history_user   ON trade_history (user_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_ticker ON trade_history (asset_ticker, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_pnl    ON trade_history (pnl DESC);
CREATE INDEX IF NOT EXISTS idx_holdings_user  ON asset_holdings (user_id);

-- ---------- UPSERT template (single-row-per-asset enforcement) ----------
-- INSERT INTO asset_holdings (user_id, asset_ticker, direction, quantity, avg_entry_price, leverage, margin_used)
-- VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
-- ON CONFLICT(user_id, asset_ticker) DO UPDATE SET
--     quantity        = asset_holdings.quantity + excluded.quantity,
--     avg_entry_price = (asset_holdings.avg_entry_price * asset_holdings.quantity
--                        + excluded.avg_entry_price * excluded.quantity)
--                       / (asset_holdings.quantity + excluded.quantity),
--     margin_used     = asset_holdings.margin_used + excluded.margin_used,
--     updated_at      = unixepoch();

-- ---------- Seed instruments (15 tickers) ----------
INSERT OR IGNORE INTO market_state (ticker, asset_class, name, price, base_price, volatility, drift, dividend) VALUES
 ('LUMB','STOCK','Lumban Lakeside Holdings',42.50,42.50,0.0042,0.00005,0.030),
 ('PALY','STOCK','Palayan Agro Corp',18.75,18.75,0.0050,0.00004,0.045),
 ('BKEX','STOCK','Bikol Express Logistics',66.20,66.20,0.0038,0.00004,0.020),
 ('TAAL','STOCK','Taal Ridge Energy',120.00,120.00,0.0055,0.00003,0.035),
 ('SAMP','STOCK','Sampaguita Telecom',88.40,88.40,0.0030,0.00004,0.025),
 ('JPNT','STOCK','Jeepney United Transit',9.60,9.60,0.0060,0.00005,0.040),
 ('MNGO','STOCK','Mango Coast Resorts',54.10,54.10,0.0048,0.00004,0.028),
 ('BARO','STOCK','Barong Textile Mills',23.85,23.85,0.0045,0.00003,0.032),
 ('SNGF','STOCK','Sinigang Foods International',35.00,35.00,0.0036,0.00005,0.038),
 ('USDPHP','FOREX','US Dollar / Philippine Peso',58.50,58.50,0.0011,0.000005,0),
 ('EURPHP','FOREX','Euro / Philippine Peso',63.20,63.20,0.0012,0.000004,0),
 ('JPYPHP','FOREX','Japanese Yen / Philippine Peso',0.3920,0.3920,0.0013,0.000004,0),
 ('MKCBD','REALESTATE','Makati CBD Prime (per sqm)',385000,385000,0.0009,0.00001,0),
 ('BGC','REALESTATE','Bonifacio Global District (per sqm)',420000,420000,0.0008,0.00001,0),
 ('CBIT','REALESTATE','Cebu IT Park Strip (per sqm)',165000,165000,0.0010,0.00001,0);
