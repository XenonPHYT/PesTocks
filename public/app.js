/* ============================================================
   PESTOCKS · Client engine (vanilla ES6+, no dependencies)
   - Server-authoritative fetch layer
   - Atomic UI locking for trade execution
   - Responsive native-SVG charts
   - Local state-machine Security Assistant (recovery chat)
   ============================================================ */
'use strict';

/* ================= Utilities ================= */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const fmtPHP = (n) => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) => Number(n) >= 100 ? Number(n).toLocaleString('en-PH', { maximumFractionDigits: 2 })
                                       : Number(n).toLocaleString('en-PH', { maximumFractionDigits: 4 });

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.remove('hidden');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), 3200);
}

/* ================= Network layer ================= */
const api = {
  token: sessionStorage.getItem('ps_token') || '',

  async call(path, body, method = 'POST') {
    const headers = { 'Content-Type': 'application/json' };
    if (api.token) headers['Authorization'] = 'Bearer ' + api.token;
    const res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  },
  get(path) { return api.call(path, undefined, 'GET'); },
  post(path, body) { return api.call(path, body, 'POST'); },

  setToken(t) {
    api.token = t || '';
    if (t) sessionStorage.setItem('ps_token', t);
    else sessionStorage.removeItem('ps_token');
  },
};

/* ============ Atomic UI locking ============ */
const locks = new Set();
function withLock(key, el, fn) {
  if (locks.has(key)) return;
  locks.add(key);
  if (el) el.disabled = true;
  Promise.resolve()
    .then(fn)
    .catch((e) => toast(e.message || 'Network error', true))
    .finally(() => {
      locks.delete(key);
      if (el) el.disabled = false;
    });
}

/* ================= Global state ================= */
const state = {
  market: {},          // ticker -> { price, name, class, ... }
  history: {},         // ticker -> number[] (local sparkline buffer)
  selected: null,
  orderSide: 'BUY',
  positions: [],
  pending: [],
  profile: null,
  pollTimer: null,
};

const FEE = { STOCK: 0.001, FOREX: 0.0005, REALESTATE: 0.02 };

/* ================= Auth screens ================= */
function showApp() {
  $('#auth-screen').classList.add('hidden');
  $('#app-screen').classList.remove('hidden');
  startApp();
}
function showAuth() {
  $('#app-screen').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  clearInterval(state.pollTimer);
}

$('#tab-login').addEventListener('click', () => {
  $('#tab-login').classList.add('active'); $('#tab-signup').classList.remove('active');
  $('#tab-login').setAttribute('aria-selected', 'true'); $('#tab-signup').setAttribute('aria-selected', 'false');
  $('#login-form').classList.remove('hidden'); $('#signup-form').classList.add('hidden');
});
$('#tab-signup').addEventListener('click', () => {
  $('#tab-signup').classList.add('active'); $('#tab-login').classList.remove('active');
  $('#tab-signup').setAttribute('aria-selected', 'true'); $('#tab-login').setAttribute('aria-selected', 'false');
  $('#signup-form').classList.remove('hidden'); $('#login-form').classList.add('hidden');
});

$('#login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#login-submit'), msg = $('#login-msg');
  msg.textContent = ''; msg.classList.remove('ok');
  withLock('login', btn, async () => {
    try {
      const r = await api.post('/api/login', {
        username: $('#login-username').value.trim(),
        password: $('#login-password').value,
      });
      api.setToken(r.token);
      toast('Welcome back, ' + r.username + '!');
      showApp();
    } catch (err) { msg.textContent = err.message; }
  });
});

$('#signup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#signup-submit'), msg = $('#signup-msg');
  msg.textContent = ''; msg.classList.remove('ok');
  const pin = $('#signup-pin').value;
  if (!/^\d{6}$/.test(pin)) { msg.textContent = 'Backup PIN must be exactly 6 digits.'; return; }
  withLock('signup', btn, async () => {
    try {
      const pinHash = await sha256Hex(pin);
      const answerHash = await sha256Hex($('#signup-answer').value.trim().toLowerCase());
      const r = await api.post('/api/signup', {
        username: $('#signup-username').value.trim(),
        password: $('#signup-password').value,
        secretQuestion: $('#signup-question').value,
        secretAnswerHash: answerHash,
        backupPinHash: pinHash,
      });
      api.setToken(r.token);
      toast('Account created — welcome to PESTOCKS!');
      showApp();
    } catch (err) { msg.textContent = err.message; }
  });
});

$('#btn-logout').addEventListener('click', () => {
  withLock('logout', $('#btn-logout'), async () => {
    try { await api.post('/api/logout', {}); } catch (_) { /* token may be gone */ }
    api.setToken('');
    showAuth();
  });
});

/* ============================================================
   SECURITY ASSISTANT · local conversational state machine
   Zero external calls except server verification endpoints.
   ============================================================ */
const chat = {
  el: { shell: $('#recovery-chat'), log: $('#chat-log'), form: $('#chat-form'), input: $('#chat-input'), send: $('#chat-send'), status: $('#chat-status') },
  step: 'IDLE',           // IDLE -> ASK_CREDS -> ASK_ANSWER -> RESET -> LOCKED
  fails: 0,
  username: '',
  resetToken: '',
  lockUntil: 0,
  lockTimer: null,

  open() {
    this.el.shell.classList.remove('hidden');
    this.el.log.innerHTML = '';
    this.fails = 0;
    this.transition('ASK_CREDS');
    this.el.input.focus();
  },
  close() { this.el.shell.classList.add('hidden'); },

  bubble(text, kind) {
    const d = document.createElement('div');
    d.className = 'chat-msg ' + kind;
    d.textContent = text;
    this.el.log.appendChild(d);
    this.el.log.scrollTop = this.el.log.scrollHeight;
    return d;
  },
  async botSay(text, kind = 'bot') {
    const typing = document.createElement('div');
    typing.className = 'chat-msg bot';
    typing.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
    this.el.log.appendChild(typing);
    this.el.log.scrollTop = this.el.log.scrollHeight;
    await new Promise((r) => setTimeout(r, 450 + Math.random() * 400));
    typing.remove();
    this.bubble(text, kind);
  },

  setLocked(flag) {
    this.el.input.disabled = flag;
    this.el.send.disabled = flag;
    this.el.input.placeholder = flag ? 'Input locked — cooling down…' : 'Type your reply…';
  },

  transition(step, payload) {
    this.step = step;
    switch (step) {
      case 'ASK_CREDS':
        this.setLocked(false);
        this.botSay('Hello. I am the PESTOCKS Security Assistant. To recover your account, please reply with your Username and Backup 6-PIN separated by a space.\nExample: juan 123456');
        break;
      case 'ASK_ANSWER':
        this.botSay('Identity confirmed, ' + this.username + '. Please answer your security question:\n\n"' + payload.question + '"');
        break;
      case 'RESET':
        this.injectResetForm();
        break;
      case 'LOCKED': {
        const secs = payload.cooldown || 60;
        this.lockUntil = Date.now() + secs * 1000;
        this.setLocked(true);
        this.el.status.textContent = 'Locked · cooling down';
        this.el.status.style.color = 'var(--red)';
        this.botSay('⚠️ Too many failed verification attempts. For your protection, this recovery session is locked for ' + secs + ' seconds.', 'warn');
        this.lockTimer = setInterval(() => {
          const left = Math.ceil((this.lockUntil - Date.now()) / 1000);
          this.el.status.textContent = 'Locked · ' + Math.max(0, left) + 's remaining';
          if (left <= 0) {
            clearInterval(this.lockTimer);
            this.fails = 0;
            this.el.status.textContent = 'Online · Account Recovery';
            this.el.status.style.color = '';
            this.botSay('Cooldown complete. You may try again.');
            this.transition('ASK_CREDS');
          }
        }, 1000);
        break;
      }
    }
  },

  async handleUserText(raw) {
    const text = raw.trim();
    if (!text || this.step === 'IDLE' || this.step === 'LOCKED' || this.step === 'RESET') return;
    this.bubble(text, 'user');

    if (this.step === 'ASK_CREDS') {
      const m = text.match(/^(\S+)\s+(\d{6})$/);
      if (!m) { this.botSay('Format not recognized. Please type: <username> <6-digit PIN>, e.g. "juan 123456".'); return; }
      const [, username, pin] = m;
      this.setLocked(true); // atomic lock during server round-trip
      try {
        const pinHash = await sha256Hex(pin);
        const r = await api.post('/api/recovery/verify-pin', { username, pinHash });
        this.username = username;
        this.fails = 0;
        this.setLocked(false);
        this.transition('ASK_ANSWER', { question: r.question });
      } catch (err) {
        this.setLocked(false);
        this.registerFail(err);
      }
      return;
    }

    if (this.step === 'ASK_ANSWER') {
      this.setLocked(true);
      try {
        const answerHash = await sha256Hex(text.toLowerCase());
        const r = await api.post('/api/recovery/verify-answer', { username: this.username, answerHash });
        this.resetToken = r.resetToken;
        this.fails = 0;
        this.setLocked(false);
        this.botSay('Answer verified. You may now set a new password below.', 'ok');
        this.transition('RESET');
      } catch (err) {
        this.setLocked(false);
        this.registerFail(err);
      }
    }
  },

  registerFail(err) {
    const p = err.payload || {};
    if (p.locked) {
      this.transition('LOCKED', { cooldown: p.cooldown || 60 });
      return;
    }
    this.fails += 1;
    const left = Math.max(0, 3 - this.fails);
    if (this.fails >= 3) {
      this.transition('LOCKED', { cooldown: 60 });
    } else {
      this.botSay('Verification failed. ' + (err.message || 'Credentials do not match our records.') + ' You have ' + left + ' attempt' + (left === 1 ? '' : 's') + ' remaining.');
    }
  },

  injectResetForm() {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg bot';
    const label = document.createElement('div');
    label.textContent = 'Set your new password (min. 8 characters):';
    const form = document.createElement('form');
    form.className = 'chat-reset-form';
    const input = document.createElement('input');
    input.type = 'password'; input.minLength = 8; input.required = true;
    input.placeholder = 'New password'; input.autocomplete = 'new-password';
    const btn = document.createElement('button');
    btn.type = 'submit'; btn.className = 'btn btn-primary'; btn.textContent = 'Reset Password';
    form.append(input, btn);
    wrap.append(label, form);
    this.el.log.appendChild(wrap);
    this.el.log.scrollTop = this.el.log.scrollHeight;
    this.setLocked(true);
    input.focus();

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      withLock('resetpw', btn, async () => {
        try {
          await api.post('/api/reset', {
            username: this.username,
            resetToken: this.resetToken,
            newPassword: input.value,
          });
          form.remove();
          this.botSay('✅ Password updated successfully. You can now log in with your new credentials.', 'ok');
          this.transition('IDLE');
          setTimeout(() => this.close(), 1800);
        } catch (err) {
          this.botSay(err.message || 'Reset failed. Please restart recovery.', 'warn');
        }
      });
    }, { once: true });
  },
};

$('#open-recovery').addEventListener('click', () => chat.open());
$('#close-recovery').addEventListener('click', () => chat.close());
$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = chat.el.input.value;
  chat.el.input.value = '';
  chat.handleUserText(v);
});

/* ================= Navigation ================= */
$$('.nav-btn').forEach((b) => b.addEventListener('click', () => {
  $$('.nav-btn').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + b.dataset.view));
  if (b.dataset.view === 'profile') loadProfile();
}));

/* ================= Market rendering ================= */
function renderTickerTape() {
  const tickers = Object.keys(state.market);
  const items = tickers.map((t) => {
    const m = state.market[t];
    const cls = m.change >= 0 ? 'up' : 'down';
    const arrow = m.change >= 0 ? '▲' : '▼';
    return '<span class="tape-item"><b>' + t + '</b> ' + fmtPHP(m.price) +
      ' <span class="' + cls + '">' + arrow + ' ' + Math.abs(m.change).toFixed(2) + '%</span></span>';
  }).join('');
  $('#ticker-tape').innerHTML = '<span class="tape-inner">' + items + items + '</span>';
}

function assetRow(t) {
  const m = state.market[t];
  const cls = m.change >= 0 ? 'up' : 'down';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'asset-row' + (state.selected === t ? ' selected' : '');
  btn.dataset.ticker = t;
  const name = document.createElement('span');
  name.className = 'asset-name';
  const b = document.createElement('b'); b.textContent = t;
  const s = document.createElement('span'); s.textContent = m.name;
  name.append(b, s);
  const price = document.createElement('span');
  price.className = 'asset-price'; price.textContent = fmtPHP(m.price);
  const chg = document.createElement('span');
  chg.className = 'asset-chg ' + cls;
  chg.textContent = (m.change >= 0 ? '+' : '') + m.change.toFixed(2) + '%';
  btn.append(name, price, chg);
  btn.addEventListener('click', () => selectAsset(t));
  return btn;
}

function renderAssetLists() {
  const groups = { STOCKS: [], FOREX: [], REALESTATE: [] };
  Object.keys(state.market).forEach((t) => {
    const c = state.market[t].asset_class;
    if (groups[c]) groups[c].push(t);
  });
  const fill = (id, arr) => {
    const el = $(id);
    el.innerHTML = '';
    arr.sort().forEach((t) => el.appendChild(assetRow(t)));
  };
  fill('#list-stocks', groups.STOCKS);
  fill('#list-forex', groups.FOREX);
  fill('#list-realestate', groups.REALESTATE);
}

function selectAsset(t) {
  state.selected = t;
  $$('.asset-row').forEach((r) => r.classList.toggle('selected', r.dataset.ticker === t));
  $('#chart-title').textContent = t + ' · ' + (state.market[t] ? state.market[t].name : '');
  const sel = $('#order-ticker');
  if (sel && [...sel.options].some((o) => o.value === t)) sel.value = t;
  drawChart();
  updateOrderEstimates();
}

/* ---------- Native responsive SVG chart ---------- */
function drawChart() {
  const svg = $('#price-chart');
  const t = state.selected;
  svg.innerHTML = '';
  if (!t || !state.history[t] || state.history[t].length < 2) return;

  const W = 600, H = 220, PAD = 8;
  const data = state.history[t];
  const min = Math.min(...data), max = Math.max(...data);
  const span = (max - min) || (max * 0.001) || 1;
  const x = (i) => PAD + (i / (data.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2);

  const ns = 'http://www.w3.org/2000/svg';
  for (let g = 1; g <= 3; g++) {
    const line = document.createElementNS(ns, 'line');
    const gy = (H / 4) * g;
    line.setAttribute('x1', 0); line.setAttribute('x2', W);
    line.setAttribute('y1', gy); line.setAttribute('y2', gy);
    line.setAttribute('class', 'chart-grid');
    svg.appendChild(line);
    const lbl = document.createElementNS(ns, 'text');
    lbl.setAttribute('x', PAD); lbl.setAttribute('y', gy - 4);
    lbl.setAttribute('class', 'chart-label');
    lbl.textContent = (max - (span / 4) * g).toFixed(2);
    svg.appendChild(lbl);
  }

  const pts = data.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', PAD + ',' + (H - PAD) + ' ' + pts + ' ' + (W - PAD) + ',' + (H - PAD));
  area.setAttribute('class', 'chart-area');
  svg.appendChild(area);

  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', pts);
  line.setAttribute('class', 'chart-line');
  svg.appendChild(line);

  const last = data[data.length - 1];
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', x(data.length - 1)); dot.setAttribute('cy', y(last));
  dot.setAttribute('r', 4); dot.setAttribute('class', 'chart-dot');
  svg.appendChild(dot);

  const m = state.market[t];
  const pc = $('#chart-price');
  pc.textContent = fmtPHP(m.price) + ' (' + (m.change >= 0 ? '+' : '') + m.change.toFixed(2) + '%)';
  pc.style.color = m.change >= 0 ? 'var(--green)' : 'var(--red)';
}

/* ================= Order entry ================= */
function populateOrderSelect() {
  const sel = $('#order-ticker');
  sel.innerHTML = '';
  Object.keys(state.market).sort().forEach((t) => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t + ' — ' + state.market[t].name;
    sel.appendChild(o);
  });
  if (state.selected) sel.value = state.selected;
}

function updateOrderEstimates() {
  const t = $('#order-ticker').value;
  const m = state.market[t];
  if (!m) return;
  const amount = Math.max(0, parseFloat($('#order-amount').value) || 0);
  const lev = parseInt($('#order-leverage').value, 10);
  $('#lev-out').textContent = lev + '×';
  const fee = amount * (FEE[m.asset_class] || 0);
  $('#margin-out').textContent = fmtPHP(amount / lev);
  $('#fee-out').textContent = fmtPHP(fee);
  $('#qty-out').textContent = fmtQty(amount / m.price) + (m.asset_class === 'REALESTATE' ? ' sqm' : ' units');
}

['order-ticker', 'order-amount', 'order-leverage'].forEach((id) =>
  $('#' + id).addEventListener('input', updateOrderEstimates));

$('#order-type').addEventListener('change', () => {
  const v = $('#order-type').value;
  $('#limit-price-wrap').classList.toggle('hidden', v === 'MARKET');
  $('#order-trigger').required = v !== 'MARKET';
});

$$('.side-btn').forEach((b) => b.addEventListener('click', () => {
  state.orderSide = b.dataset.side;
  $$('.side-btn').forEach((x) => x.classList.toggle('active', x === b));
}));

$('#order-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const btn = $('#order-submit'), msg = $('#order-msg');
  msg.textContent = ''; msg.classList.remove('ok');
  withLock('trade', btn, async () => {           // atomic lock: no double submission
    const type = $('#order-type').value;
    const payload = {
      ticker: $('#order-ticker').value,
      orderType: type,
      side: state.orderSide,
      leverage: parseInt($('#order-leverage').value, 10),
      amount: parseFloat($('#order-amount').value),
    };
    if (type !== 'MARKET') payload.triggerPrice = parseFloat($('#order-trigger').value);
    try {
      const r = await api.post('/api/trade', payload);
      msg.classList.add('ok');
      msg.textContent = r.message || 'Order executed.';
      toast(msg.textContent);
      await refreshPortfolio();
      await refreshBalanceChip();
    } catch (err) { msg.textContent = err.message; }
  });
});

/* ================= Portfolio tables ================= */
function renderPositions() {
  const tbody = $('#positions-table tbody');
  tbody.innerHTML = '';
  state.positions.forEach((p) => {
    const m = state.market[p.asset_ticker];
    const price = m ? m.price : p.avg_entry_price;
    const pnl = p.direction === 'LONG'
      ? (price - p.avg_entry_price) * p.quantity * p.leverage
      : (p.avg_entry_price - price) * p.quantity * p.leverage;
    const tr = document.createElement('tr');
    const cells = [p.asset_ticker, p.direction, fmtQty(p.quantity), fmtPHP(p.avg_entry_price)];
    cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
    const tdPnl = document.createElement('td');
    tdPnl.textContent = (pnl >= 0 ? '+' : '') + fmtPHP(pnl);
    tdPnl.className = pnl >= 0 ? 'up' : 'down';
    tr.appendChild(tdPnl);
    const tdBtn = document.createElement('td');
    const close = document.createElement('button');
    close.className = 'row-close'; close.textContent = 'Close';
    close.addEventListener('click', () => {
      withLock('close-' + p.asset_ticker, close, async () => {
        try {
          const r = await api.post('/api/close', { ticker: p.asset_ticker });
          toast(r.message || 'Position closed.');
          await refreshPortfolio();
          await refreshBalanceChip();
        } catch (err) { toast(err.message, true); }
      });
    });
    tdBtn.appendChild(close);
    tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
  if (!state.positions.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 6;
    td.textContent = 'No open positions.'; td.style.color = 'var(--txt-dim)';
    tr.appendChild(td); tbody.appendChild(tr);
  }
}

function renderPending() {
  const tbody = $('#pending-table tbody');
  tbody.innerHTML = '';
  state.pending.forEach((o) => {
    const tr = document.createElement('tr');
    [o.asset_ticker, o.order_type, o.side, fmtPHP(o.trigger_price), fmtQty(o.quantity)].forEach((c) => {
      const td = document.createElement('td'); td.textContent = c; tr.appendChild(td);
    });
    const tdBtn = document.createElement('td');
    const cx = document.createElement('button');
    cx.className = 'row-close'; cx.textContent = 'Cancel';
    cx.addEventListener('click', () => {
      withLock('cancel-' + o.order_id, cx, async () => {
        try {
          await api.post('/api/orders/cancel', { orderId: o.order_id });
          toast('Order cancelled.');
          await refreshPortfolio();
        } catch (err) { toast(err.message, true); }
      });
    });
    tdBtn.appendChild(cx); tr.appendChild(tdBtn);
    tbody.appendChild(tr);
  });
  if (!state.pending.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td'); td.colSpan = 6;
    td.textContent = 'No pending orders.'; td.style.color = 'var(--txt-dim)';
    tr.appendChild(td); tbody.appendChild(tr);
  }
}

/* ================= Profile & progression ================= */
const expForLevel = (lvl) => 5000000 * Math.pow((lvl - 1) / 49, 2);
const levelFromExp = (exp) => Math.min(50, Math.max(1, Math.floor(1 + 49 * Math.sqrt(Math.max(0, exp) / 5000000))));

async function loadProfile() {
  withLock('profile', null, async () => {
    try {
      const p = await api.get('/api/profile');
      state.profile = p;
      const lvl = levelFromExp(p.exp);
      const curBase = expForLevel(lvl);
      const next = expForLevel(lvl + 1);
      const prog = lvl >= 50 ? 1 : (p.exp - curBase) / (next - curBase);
      $('#profile-level').textContent = lvl;
      $('#top-level').textContent = 'Lv ' + lvl;
      $('#exp-line').textContent = lvl >= 50 ? 'MAX LEVEL · ' + Math.floor(p.exp).toLocaleString() + ' EXP'
        : Math.floor(p.exp - curBase).toLocaleString() + ' / ' + Math.floor(next - curBase).toLocaleString() + ' EXP';
      $('#exp-ring').style.strokeDashoffset = (326.7 * (1 - Math.max(0, Math.min(1, prog)))).toFixed(1);
      $('#stat-wins').textContent = p.wins;
      $('#stat-losses').textContent = p.losses;
      $('#stat-pnl').textContent = (p.realized_pnl >= 0 ? '+' : '') + fmtPHP(p.realized_pnl);
      $('#stat-hold').textContent = Math.round(p.holding_seconds / 3600) + 'h';

      const tbody = $('#asset-stats-table tbody');
      tbody.innerHTML = '';
      (p.assetStats || []).forEach((a) => {
        const tr = document.createElement('tr');
        [a.asset_ticker, a.trades, (a.pnl >= 0 ? '+' : '') + fmtPHP(a.pnl)].forEach((c, i) => {
          const td = document.createElement('td'); td.textContent = c;
          if (i === 2) td.className = a.pnl >= 0 ? 'up' : 'down';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      const top = $('#top-trades');
      top.innerHTML = '';
      (p.topTrades || []).forEach((t, i) => {
        const li = document.createElement('li');
        const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
        const mid = document.createElement('span');
        mid.textContent = t.username + ' · ' + t.asset_ticker + ' ' + t.side;
        mid.style.flex = '1';
        const pnl = document.createElement('span');
        pnl.textContent = '+' + fmtPHP(t.pnl); pnl.className = 'up';
        li.append(rank, mid, pnl);
        top.appendChild(li);
      });

      const hb = $('#history-table tbody');
      hb.innerHTML = '';
      (p.history || []).forEach((h) => {
        const tr = document.createElement('tr');
        const time = new Date(h.executed_at * 1000).toLocaleString();
        [time, h.asset_ticker, h.side, fmtQty(h.quantity), fmtPHP(h.price)].forEach((c) => {
          const td = document.createElement('td'); td.textContent = c; tr.appendChild(td);
        });
        const td = document.createElement('td');
        td.textContent = (h.pnl >= 0 ? '+' : '') + fmtPHP(h.pnl);
        td.className = h.pnl >= 0 ? 'up' : 'down';
        tr.appendChild(td);
        hb.appendChild(tr);
      });
    } catch (err) { toast(err.message, true); }
  });
}

/* ================= Data polling ================= */
async function refreshMarket() {
  try {
    const r = await api.get('/api/market');
    r.assets.forEach((a) => {
      state.market[a.ticker] = a;
      const h = state.history[a.ticker] || (state.history[a.ticker] = []);
      h.push(a.price);
      if (h.length > 90) h.shift();
    });
    renderTickerTape();
    renderAssetLists();
    drawChart();
    updateOrderEstimates();
    renderPositions(); // live P&L marks
    if (!state.selected && r.assets.length) selectAsset(r.assets[0].ticker);
    if (r.filledOrders && r.filledOrders.length) {
      toast(r.filledOrders.length + ' pending order(s) filled: ' + r.filledOrders.join(', '));
      refreshPortfolio();
      refreshBalanceChip();
    }
  } catch (err) {
    if (err.status === 401) { api.setToken(''); showAuth(); }
  }
}

async function refreshPortfolio() {
  try {
    const r = await api.get('/api/portfolio');
    state.positions = r.positions || [];
    state.pending = r.pending || [];
    renderPositions();
    renderPending();
  } catch (_) { /* silent on poll path */ }
}

async function refreshBalanceChip() {
  try {
    const r = await api.get('/api/balance');
    $('#top-cash').textContent = fmtPHP(r.cash);
    $('#top-level').textContent = 'Lv ' + levelFromExp(r.exp || 0);
  } catch (_) { /* silent */ }
}

async function startApp() {
  await refreshMarket();
  populateOrderSelect();
  await Promise.all([refreshPortfolio(), refreshBalanceChip(), loadProfile()]);
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => { refreshMarket(); refreshPortfolio(); refreshBalanceChip(); }, 4000);
}

/* ================= Boot ================= */
(function boot() {
  if (api.token) {
    api.get('/api/balance')
      .then(() => showApp())
      .catch(() => { api.setToken(''); showAuth(); });
  } else {
    showAuth();
  }
})();
