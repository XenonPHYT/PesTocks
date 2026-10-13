/**
 * PESTOCKS · Cloudflare Worker (server-authoritative backend)
 * Endpoints: auth, recovery, market engine, trading, portfolio, profile.
 * Storage: D1 (SQLite). Static assets served via the ASSETS binding.
 */

/* ---------------- Helpers ---------------- */
const JSON_H = { 'Content-Type': 'application/json' };
const CORS_H = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_H, ...CORS_H } });
}
function fail(message, status = 400, extra = {}) {
  return json({ error: message, ...extra }, status);
}

const te = new TextEncoder();

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', te.encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hashPassword(password, salt) {
  return sha256Hex(salt + ':' + password);
}
function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
const now = () => Math.floor(Date.now() / 1000);

/* ---------------- Auth guard ---------------- */
async function authUser(request, env) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  const row = await env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?'
  ).bind(token, now()).first();
  return row ? row.user_id : null;
}

/* ---------------- Market engine ----------------
   Random-walk pricing applied lazily per request: each instrument
   advances by the number of elapsed 4-second buckets. Pending
   Limit / Stop-Loss orders are matched after the tick. */
const BUCKET_SECS = 4;
const FEES = { STOCK: 0.001, FOREX: 0.0005, REALESTATE: 0.02 };

async function tickMarket(env) {
  const assets = await env.DB.prepare('SELECT * FROM market_state').all();
  const filled = [];
  for (const a of assets.results || []) {
    const bucket = Math.floor(now() / BUCKET_SECS);
    let steps = Math.min(60, Math.max(0, bucket - (a.last_bucket || bucket - 1)));
    let price = a.price;
    if (steps > 0) {
      for (let i = 0; i < steps; i++) {
        const shock = (Math.random() * 2 - 1) * a.volatility;
        price = Math.max(price * (1 + shock + a.drift), a.base_price * 0.05);
      }
      price = Math.round(price * 10000) / 10000;
      await env.DB.prepare(
        'UPDATE market_state SET price = ?, last_bucket = ?, updated_at = ? WHERE ticker = ?'
      ).bind(price, bucket, now(), a.ticker).run();
    }
    const newlyFilled = await matchOrders(env, a.ticker, price);
    filled.push(...newlyFilled);
  }
  return filled;
}

async function matchOrders(env, ticker, price) {
  const open = await env.DB.prepare(
    `SELECT * FROM pending_orders WHERE asset_ticker = ? AND status = 'OPEN'
     AND ((order_type = 'LIMIT' AND side = 'BUY' AND trigger_price >= ?)
       OR (order_type = 'LIMIT' AND side = 'SELL' AND trigger_price <= ?)
       OR (order_type = 'STOP_LOSS' AND side = 'BUY' AND trigger_price <= ?)
       OR (order_type = 'STOP_LOSS' AND side = 'SELL' AND trigger_price >= ?))`
  ).bind(ticker, price, price, price, price).all();

  const filled = [];
  for (const o of open.results || []) {
    const amount = o.quantity * o.trigger_price;
    const r = await executeTrade(env, o.user_id, {
      ticker, side: o.side, amount, leverage: o.leverage, orderType: o.order_type,
    });
    if (r.ok) {
      await env.DB.prepare(
        "UPDATE pending_orders SET status = 'FILLED', resolved_at = ? WHERE order_id = ?"
      ).bind(now(), o.order_id).run();
      filled.push(ticker + ' ' + o.order_type);
    } else {
      await env.DB.prepare(
        "UPDATE pending_orders SET status = 'CANCELLED', resolved_at = ? WHERE order_id = ?"
      ).bind(now(), o.order_id).run();
    }
  }
  return filled;
}

/* ---------------- Trade execution (server-authoritative) ---------------- */
async function executeTrade(env, userId, { ticker, side, amount, leverage, orderType }) {
  const asset = await env.DB.prepare('SELECT * FROM market_state WHERE ticker = ?').bind(ticker).first();
  if (!asset) return { ok: false, error: 'Unknown asset.' };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'Invalid amount.' };
  leverage = Math.min(20, Math.max(1, Math.floor(leverage || 1)));

  const price = asset.price;
  const qty = amount / price;
  const feeRate = FEES[asset.asset_class] || 0;
  const fee = amount * feeRate;
  const margin = amount / leverage;

  const bal = await env.DB.prepare('SELECT * FROM user_balances WHERE user_id = ?').bind(userId).first();
  if (!bal) return { ok: false, error: 'Balance record missing.' };

  const holding = await env.DB.prepare(
    'SELECT * FROM asset_holdings WHERE user_id = ? AND asset_ticker = ?'
  ).bind(userId, ticker).first();

  const newDir = side === 'BUY' ? 'LONG' : 'SHORT';
  if (newDir === 'SHORT' && asset.asset_class !== 'FOREX') {
    return { ok: false, error: 'Short selling is only supported on Forex pairs.' };
  }

  let realized = 0;
  let closing = false;

  /* Opposite-direction existing position => this trade closes it. */
  if (holding && holding.direction !== newDir && holding.quantity > 0) {
    closing = true;
    const closeQty = Math.min(qty, holding.quantity);
    const dirSign = holding.direction === 'LONG' ? 1 : -1;
    realized = dirSign * (price - holding.avg_entry_price) * closeQty * holding.leverage;

    /* Accrued dividend for dividend-paying stock longs, pro-rata by hold time. */
    if (holding.direction === 'LONG' && asset.dividend > 0) {
      realized += closeQty * holding.avg_entry_price * asset.dividend *
                  ((now() - holding.opened_at) / 31536000);
    }

    const marginRelease = holding.margin_used * (closeQty / holding.quantity);
    const cashAfter = bal.cash + marginRelease + realized - fee;
    if (cashAfter < -0.0001) return { ok: false, error: 'Insufficient cash to cover settlement.' };

    await env.DB.batch([
      env.DB.prepare(
        'UPDATE user_balances SET cash = ?, updated_at = ? WHERE user_id = ?'
      ).bind(Math.max(0, cashAfter), now(), userId),
      ...(qty >= holding.quantity - 1e-9
        ? [env.DB.prepare('DELETE FROM asset_holdings WHERE user_id = ? AND asset_ticker = ?').bind(userId, ticker)]
        : [env.DB.prepare(
             'UPDATE asset_holdings SET quantity = quantity - ?, margin_used = margin_used * (1 - ? / quantity), updated_at = ? WHERE user_id = ? AND asset_ticker = ?'
           ).bind(closeQty, closeQty, now(), userId, ticker)]),
      env.DB.prepare(
        'INSERT INTO trade_history (user_id, asset_ticker, side, order_type, quantity, price, leverage, fee, pnl) VALUES (?,?,?,?,?,?,?,?,?)'
      ).bind(userId, ticker, side, orderType, closeQty, price, holding.leverage, fee, realized),
      env.DB.prepare(
        `UPDATE user_profiles SET
           wins = wins + ?,
           losses = losses + ?,
           realized_pnl = realized_pnl + ?,
           holding_seconds = holding_seconds + ?,
           updated_at = ?
         WHERE user_id = ?`
      ).bind(realized > 0 ? 1 : 0, realized < 0 ? 1 : 0, realized, now() - holding.opened_at, now(), userId),
    ]);
    await awardExp(env, userId, Math.max(0, realized) + amount * 0.001);

    /* Remainder opens a fresh opposite position. */
    const remainQty = qty - holding.quantity;
    if (remainQty > 1e-9) {
      const remainAmount = remainQty * price;
      return openPosition(env, userId, asset, ticker, side, remainAmount, remainQty, leverage, orderType);
    }
    return { ok: true, realized, closing };
  }

  return openPosition(env, userId, asset, ticker, side, amount, qty, leverage, orderType);
}

async function openPosition(env, userId, asset, ticker, side, amount, qty, leverage, orderType) {
  const fee = amount * (FEES[asset.asset_class] || 0);
  const margin = amount / leverage;
  const dir = side === 'BUY' ? 'LONG' : 'SHORT';

  const bal = await env.DB.prepare('SELECT cash FROM user_balances WHERE user_id = ?').bind(userId).first();
  if (bal.cash < margin + fee) return { ok: false, error: 'Insufficient cash for margin + fees.' };

  const price = asset.price;
  await env.DB.batch([
    env.DB.prepare('UPDATE user_balances SET cash = cash - ?, updated_at = ? WHERE user_id = ?')
      .bind(margin + fee, now(), userId),
    /* Composite-key UPSERT: exactly one row per (user, asset). */
    env.DB.prepare(
      `INSERT INTO asset_holdings (user_id, asset_ticker, direction, quantity, avg_entry_price, leverage, margin_used, opened_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, asset_ticker) DO UPDATE SET
         quantity = asset_holdings.quantity + excluded.quantity,
         avg_entry_price = (asset_holdings.avg_entry_price * asset_holdings.quantity
                            + excluded.avg_entry_price * excluded.quantity)
                           / (asset_holdings.quantity + excluded.quantity),
         margin_used = asset_holdings.margin_used + excluded.margin_used,
         updated_at = excluded.updated_at`
    ).bind(userId, ticker, dir, qty, price, leverage, margin, now(), now()),
    env.DB.prepare(
      'INSERT INTO trade_history (user_id, asset_ticker, side, order_type, quantity, price, leverage, fee, pnl) VALUES (?,?,?,?,?,?,?,?,0)'
    ).bind(userId, ticker, side, orderType, qty, price, leverage, fee),
  ]);
  await awardExp(env, userId, amount * 0.001);
  return { ok: true, realized: 0, closing: false };
}

/* ---------------- EXP / progression ---------------- */
const DAILY_EXP_CAP = 50000;
async function awardExp(env, userId, amount) {
  if (amount <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const p = await env.DB.prepare('SELECT exp, daily_exp_earned, daily_exp_date FROM user_profiles WHERE user_id = ?')
    .bind(userId).first();
  if (!p) return;
  const usedToday = p.daily_exp_date === today ? p.daily_exp_earned : 0;
  const grant = Math.min(amount, Math.max(0, DAILY_EXP_CAP - usedToday));
  if (grant <= 0) return;
  const newExp = Math.min(5000000, p.exp + grant);
  const level = Math.min(50, Math.max(1, Math.floor(1 + 49 * Math.sqrt(newExp / 5000000))));
  await env.DB.prepare(
    'UPDATE user_profiles SET exp = ?, level = ?, daily_exp_earned = ?, daily_exp_date = ?, updated_at = ? WHERE user_id = ?'
  ).bind(newExp, level, usedToday + grant, today, now(), userId).run();
}

/* ---------------- Recovery lockout ---------------- */
const RECOVERY_COOLDOWN = 60; // seconds
async function checkRecoveryLock(env, user) {
  const locked = user.recovery_attempts >= 3 && (now() - user.last_recovery_attempt) < RECOVERY_COOLDOWN;
  if (locked) {
    return RECOVERY_COOLDOWN - (now() - user.last_recovery_attempt);
  }
  if (user.recovery_attempts >= 3 && (now() - user.last_recovery_attempt) >= RECOVERY_COOLDOWN) {
    await env.DB.prepare('UPDATE users SET recovery_attempts = 0 WHERE user_id = ?').bind(user.user_id).run();
    user.recovery_attempts = 0;
  }
  return 0;
}
async function bumpRecoveryFail(env, userId) {
  await env.DB.prepare(
    'UPDATE users SET recovery_attempts = recovery_attempts + 1, last_recovery_attempt = ? WHERE user_id = ?'
  ).bind(now(), userId).run();
}

/* ---------------- Route handlers ---------------- */
async function handleSignup(request, env) {
  const { username, password, secretQuestion, secretAnswerHash, backupPinHash } = await request.json().catch(() => ({}));
  if (!username || !/^[A-Za-z0-9_]{3,24}$/.test(username)) return fail('Username must be 3–24 chars (letters, digits, underscore).');
  if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
  if (!secretQuestion) return fail('Secret question required.');
  if (!/^[a-f0-9]{64}$/.test(secretAnswerHash || '')) return fail('Invalid secret answer digest.');
  if (!/^[a-f0-9]{64}$/.test(backupPinHash || '')) return fail('Invalid backup PIN digest.');

  const exists = await env.DB.prepare('SELECT user_id FROM users WHERE username = ?').bind(username).first();
  if (exists) return fail('Username is already taken.', 409);

  const salt = randomToken();
  const pwHash = await hashPassword(password, salt);

  const r = await env.DB.prepare(
    'INSERT INTO users (username, password_hash, password_salt, secret_question, secret_answer_hash, backup_pin_hash) VALUES (?,?,?,?,?,?)'
  ).bind(username, pwHash, salt, secretQuestion, secretAnswerHash, backupPinHash).run();
  const userId = r.meta.last_row_id;

  await env.DB.batch([
    env.DB.prepare('INSERT INTO user_profiles (user_id) VALUES (?)').bind(userId),
    env.DB.prepare('INSERT INTO user_balances (user_id, cash) VALUES (?, 100000)').bind(userId),
  ]);

  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .bind(token, userId, now() + 60 * 60 * 24 * 14).run();
  return json({ token, username });
}

async function handleLogin(request, env) {
  const { username, password } = await request.json().catch(() => ({}));
  if (!username || !password) return fail('Username and password required.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return fail('Invalid credentials.', 401);
  const pwHash = await hashPassword(password, user.password_salt);
  if (pwHash !== user.password_hash) return fail('Invalid credentials.', 401);

  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .bind(token, user.user_id, now() + 60 * 60 * 24 * 14).run();
  return json({ token, username: user.username });
}

async function handleLogout(request, env, userId) {
  const h = request.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true });
}

/* Recovery step 1: username + PIN hash -> returns ONLY that user's secret question */
async function handleVerifyPin(request, env) {
  const { username, pinHash } = await request.json().catch(() => ({}));
  if (!username || !/^[a-f0-9]{64}$/.test(pinHash || '')) return fail('Malformed request.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return fail('Account not found.', 404);

  const lockLeft = await checkRecoveryLock(env, user);
  if (lockLeft > 0) return fail('Recovery is temporarily locked.', 429, { locked: true, cooldown: lockLeft });

  if (user.backup_pin_hash !== pinHash) {
    await bumpRecoveryFail(env, user.user_id);
    const attempts = user.recovery_attempts + 1;
    if (attempts >= 3) return fail('PIN incorrect. Too many attempts.', 429, { locked: true, cooldown: RECOVERY_COOLDOWN });
    return fail('PIN incorrect.', 401, { attempts });
  }
  await env.DB.prepare('UPDATE users SET recovery_attempts = 0 WHERE user_id = ?').bind(user.user_id).run();
  return json({ question: user.secret_question });
}

/* Recovery step 2: answer hash -> one-time reset token */
async function handleVerifyAnswer(request, env) {
  const { username, answerHash } = await request.json().catch(() => ({}));
  if (!username || !/^[a-f0-9]{64}$/.test(answerHash || '')) return fail('Malformed request.');
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return fail('Account not found.', 404);

  const lockLeft = await checkRecoveryLock(env, user);
  if (lockLeft > 0) return fail('Recovery is temporarily locked.', 429, { locked: true, cooldown: lockLeft });

  if (user.secret_answer_hash !== answerHash) {
    await bumpRecoveryFail(env, user.user_id);
    const attempts = user.recovery_attempts + 1;
    if (attempts >= 3) return fail('Answer incorrect. Too many attempts.', 429, { locked: true, cooldown: RECOVERY_COOLDOWN });
    return fail('Answer incorrect.', 401, { attempts });
  }
  await env.DB.prepare('UPDATE users SET recovery_attempts = 0 WHERE user_id = ?').bind(user.user_id).run();
  const resetToken = randomToken();
  await env.DB.prepare('INSERT INTO recovery_tokens (token, user_id, expires_at) VALUES (?,?,?)')
    .bind(resetToken, user.user_id, now() + 600).run();
  return json({ resetToken });
}

async function handleReset(request, env) {
  const { username, resetToken, newPassword } = await request.json().catch(() => ({}));
  if (!username || !resetToken || !newPassword || newPassword.length < 8) {
    return fail('Valid reset token and a password of 8+ characters are required.');
  }
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) return fail('Account not found.', 404);
  const tok = await env.DB.prepare(
    'SELECT * FROM recovery_tokens WHERE token = ? AND user_id = ? AND used = 0 AND expires_at > ?'
  ).bind(resetToken, user.user_id, now()).first();
  if (!tok) return fail('Reset token is invalid or expired.', 401);

  const salt = randomToken();
  const pwHash = await hashPassword(newPassword, salt);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, recovery_attempts = 0 WHERE user_id = ?')
      .bind(pwHash, salt, user.user_id),
    env.DB.prepare('UPDATE recovery_tokens SET used = 1 WHERE token = ?').bind(resetToken),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.user_id),
  ]);
  return json({ ok: true });
}

async function handleMarket(env) {
  const filledOrders = await tickMarket(env);
  const rows = await env.DB.prepare('SELECT ticker, asset_class, name, price, base_price, dividend FROM market_state').all();
  const assets = (rows.results || []).map((a) => ({
    ticker: a.ticker,
    asset_class: a.asset_class,
    name: a.name,
    price: a.price,
    dividend: a.dividend,
    change: Math.round(((a.price - a.base_price) / a.base_price) * 10000) / 100,
  }));
  return json({ assets, filledOrders });
}

async function handleTrade(request, env, userId) {
  const body = await request.json().catch(() => ({}));
  const { ticker, side, orderType, leverage, amount, triggerPrice } = body;
  if (!ticker || !['BUY', 'SELL'].includes(side)) return fail('Invalid trade parameters.');
  if (!['MARKET', 'LIMIT', 'STOP_LOSS'].includes(orderType)) return fail('Invalid order type.');
  if (!Number.isFinite(amount) || amount < 100) return fail('Minimum order amount is ₱100.');

  await tickMarket(env);
  const asset = await env.DB.prepare('SELECT * FROM market_state WHERE ticker = ?').bind(ticker).first();
  if (!asset) return fail('Unknown asset.', 404);

  if (orderType === 'MARKET') {
    const r = await executeTrade(env, userId, { ticker, side, amount, leverage, orderType });
    if (!r.ok) return fail(r.error);
    return json({
      ok: true,
      message: r.closing
        ? `Position in ${ticker} closed. Realized P&L: ${r.realized >= 0 ? '+' : ''}₱${r.realized.toFixed(2)}`
        : `${side === 'BUY' ? 'Bought' : 'Sold'} ${ticker} at ₱${asset.price.toFixed(2)}.`,
    });
  }

  /* Resting orders */
  if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) return fail('Trigger price required.');
  const qty = amount / asset.price;
  const r = await env.DB.prepare(
    "INSERT INTO pending_orders (user_id, asset_ticker, side, order_type, trigger_price, quantity, leverage) VALUES (?,?,?,?,?,?,?)"
  ).bind(userId, ticker, side, orderType, triggerPrice, qty, Math.min(20, Math.max(1, Math.floor(leverage || 1)))).run();
  return json({ ok: true, message: `${orderType} order for ${ticker} placed (trigger ₱${triggerPrice.toFixed(2)}).`, orderId: r.meta.last_row_id });
}

async function handleClose(request, env, userId) {
  const { ticker } = await request.json().catch(() => ({}));
  if (!ticker) return fail('Ticker required.');
  await tickMarket(env);
  const holding = await env.DB.prepare(
    'SELECT * FROM asset_holdings WHERE user_id = ? AND asset_ticker = ?'
  ).bind(userId, ticker).first();
  if (!holding || holding.quantity <= 0) return fail('No open position for this asset.', 404);

  const asset = await env.DB.prepare('SELECT * FROM market_state WHERE ticker = ?').bind(ticker).first();
  const amount = holding.quantity * asset.price;
  const side = holding.direction === 'LONG' ? 'SELL' : 'BUY';
  const r = await executeTrade(env, userId, { ticker, side, amount, leverage: 1, orderType: 'MARKET' });
  if (!r.ok) return fail(r.error);
  return json({ ok: true, message: `Closed ${ticker}. Realized P&L: ${r.realized >= 0 ? '+' : ''}₱${r.realized.toFixed(2)}` });
}

async function handlePortfolio(env, userId) {
  const pos = await env.DB.prepare('SELECT * FROM asset_holdings WHERE user_id = ? AND quantity > 0').bind(userId).all();
  const pen = await env.DB.prepare(
    "SELECT * FROM pending_orders WHERE user_id = ? AND status = 'OPEN' ORDER BY created_at DESC"
  ).bind(userId).all();
  return json({ positions: pos.results || [], pending: pen.results || [] });
}

async function handleCancelOrder(request, env, userId) {
  const { orderId } = await request.json().catch(() => ({}));
  const r = await env.DB.prepare(
    "UPDATE pending_orders SET status = 'CANCELLED', resolved_at = ? WHERE order_id = ? AND user_id = ? AND status = 'OPEN'"
  ).bind(now(), orderId, userId).run();
  if (!r.meta.changes) return fail('Order not found or already resolved.', 404);
  return json({ ok: true });
}

async function handleBalance(env, userId) {
  const b = await env.DB.prepare('SELECT cash, locked_margin FROM user_balances WHERE user_id = ?').bind(userId).first();
  const p = await env.DB.prepare('SELECT exp, level FROM user_profiles WHERE user_id = ?').bind(userId).first();
  return json({ cash: b ? b.cash : 0, locked_margin: b ? b.locked_margin : 0, exp: p ? p.exp : 0, level: p ? p.level : 1 });
}

async function handleProfile(env, userId) {
  const p = await env.DB.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId).first();
  const assetStats = await env.DB.prepare(
    `SELECT asset_ticker, COUNT(*) AS trades, SUM(pnl) AS pnl
     FROM trade_history WHERE user_id = ? GROUP BY asset_ticker ORDER BY pnl DESC`
  ).bind(userId).all();
  const history = await env.DB.prepare(
    'SELECT asset_ticker, side, order_type, quantity, price, pnl, executed_at FROM trade_history WHERE user_id = ? ORDER BY executed_at DESC LIMIT 100'
  ).bind(userId).all();
  const topTrades = await env.DB.prepare(
    `SELECT u.username, t.asset_ticker, t.side, t.pnl
     FROM trade_history t JOIN users u ON u.user_id = t.user_id
     WHERE t.pnl > 0 ORDER BY t.pnl DESC LIMIT 5`
  ).all();
  return json({
    exp: p ? p.exp : 0,
    level: p ? p.level : 1,
    wins: p ? p.wins : 0,
    losses: p ? p.losses : 0,
    realized_pnl: p ? p.realized_pnl : 0,
    holding_seconds: p ? p.holding_seconds : 0,
    assetStats: assetStats.results || [],
    history: history.results || [],
    topTrades: topTrades.results || [],
  });
}

/* ---------------- Router ---------------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_H });
    }

    try {
      switch (url.pathname) {
        /* Public */
        case '/api/signup':
          if (request.method === 'POST') return await handleSignup(request, env);
          break;
        case '/api/login':
          if (request.method === 'POST') return await handleLogin(request, env);
          break;
        case '/api/recovery/verify-pin':
          if (request.method === 'POST') return await handleVerifyPin(request, env);
          break;
        case '/api/recovery/verify-answer':
          if (request.method === 'POST') return await handleVerifyAnswer(request, env);
          break;
        case '/api/reset':
          if (request.method === 'POST') return await handleReset(request, env);
          break;
        case '/api/market':
          if (request.method === 'GET') return await handleMarket(env);
          break;
      }

      /* Authenticated routes */
      if (url.pathname.startsWith('/api/')) {
        const userId = await authUser(request, env);
        if (!userId) return fail('Unauthorized.', 401);

        switch (url.pathname) {
          case '/api/logout':
            if (request.method === 'POST') return await handleLogout(request, env, userId);
            break;
          case '/api/trade':
            if (request.method === 'POST') return await handleTrade(request, env, userId);
            break;
          case '/api/close':
            if (request.method === 'POST') return await handleClose(request, env, userId);
            break;
          case '/api/portfolio':
            if (request.method === 'GET') return await handlePortfolio(env, userId);
            break;
          case '/api/orders/cancel':
            if (request.method === 'POST') return await handleCancelOrder(request, env, userId);
            break;
          case '/api/balance':
            if (request.method === 'GET') return await handleBalance(env, userId);
            break;
          case '/api/profile':
            if (request.method === 'GET') return await handleProfile(env, userId);
            break;
        }
        return fail('Not found.', 404);
      }

      /* Static assets (public/) */
      if (env.ASSETS) return await env.ASSETS.fetch(request);
      return fail('Not found.', 404);
    } catch (e) {
      return fail('Internal error: ' + (e && e.message ? e.message : 'unknown'), 500);
    }
  },
};
