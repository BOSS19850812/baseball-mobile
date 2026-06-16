const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8766);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const HOST = process.env.HOST || (IS_PRODUCTION ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const sessions = new Map();

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return { users: [] }; }
}

function saveUsers(db) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    plan: user.plan || 'free',
    subscriptionStatus: user.subscriptionStatus || 'inactive',
    subscriptionUntil: user.subscriptionUntil || null
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const sid = parseCookies(req).bb_session;
  if (!sid || !sessions.has(sid)) return null;
  const userId = sessions.get(sid);
  return loadUsers().users.find(u => u.id === userId) || null;
}

function isPaid(user) {
  return !!user && (user.plan === 'pro' || user.subscriptionStatus === 'active');
}

function appBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || ('127.0.0.1:' + PORT);
  return proto + '://' + host;
}

async function stripeRequest(pathname, params) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  const response = await fetch('https://api.stripe.com' + pathname, {
    method: 'POST',
    headers: {
      'authorization': 'Bearer ' + secret,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params).toString()
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || data.error || 'Stripe request failed');
  return data;
}

async function stripeGet(pathname) {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) throw new Error('STRIPE_SECRET_KEY is not set');
  const response = await fetch('https://api.stripe.com' + pathname, {
    headers: { 'authorization': 'Bearer ' + secret }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error?.message || data.error || 'Stripe request failed');
  return data;
}

function verifyStripeWebhookSignature(rawBody, signatureHeader) {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!endpointSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  const parts = String(signatureHeader || '').split(',').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const key = part.slice(0, idx);
      const value = part.slice(idx + 1);
      if (!acc[key]) acc[key] = [];
      acc[key].push(value);
    }
    return acc;
  }, {});
  const timestamp = parts.t && parts.t[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) throw new Error('Stripe signature is missing');
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error('Stripe signature timestamp is outside tolerance');
  const payload = timestamp + '.' + rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', endpointSecret).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const ok = signatures.some(sig => {
    const actualBuffer = Buffer.from(sig, 'hex');
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  });
  if (!ok) throw new Error('Stripe signature verification failed');
}

function updateStoredUser(userId, updater) {
  if (!userId) return null;
  const db = loadUsers();
  const user = db.users.find(u => u.id === userId);
  if (!user) return null;
  updater(user);
  user.updatedAt = new Date().toISOString();
  saveUsers(db);
  return user;
}

function findStripeUser(db, object) {
  const userId = object?.client_reference_id || object?.metadata?.userId;
  if (userId) {
    const byId = db.users.find(u => u.id === userId);
    if (byId) return byId;
  }
  const customer = object?.customer;
  const subscription = object?.subscription || object?.id;
  return db.users.find(u => (customer && u.stripeCustomerId === customer) || (subscription && u.stripeSubscriptionId === subscription)) || null;
}

function applyStripePaidState(user, object, active = true) {
  user.plan = active ? 'pro' : 'free';
  user.subscriptionStatus = active ? 'active' : (object?.status || 'inactive');
  if (object?.customer) user.stripeCustomerId = object.customer;
  if (object?.subscription) user.stripeSubscriptionId = object.subscription;
  if (object?.id && object.object === 'subscription') user.stripeSubscriptionId = object.id;
  user.updatedAt = new Date().toISOString();
}

async function handleStripeWebhook(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  let raw;
  try {
    raw = await readRawBody(req);
    verifyStripeWebhookSignature(raw, req.headers['stripe-signature']);
  } catch (error) {
    return json(res, 400, { error: error.message || 'invalid stripe webhook' });
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return json(res, 400, { error: 'invalid stripe event json' }); }

  const object = event?.data?.object || {};
  const db = loadUsers();
  const user = findStripeUser(db, object);
  if (user) {
    if (event.type === 'checkout.session.completed') {
      applyStripePaidState(user, object, true);
    } else if (event.type === 'customer.subscription.updated') {
      const active = ['active', 'trialing'].includes(object.status);
      applyStripePaidState(user, object, active);
      user.subscriptionStatus = object.status || user.subscriptionStatus;
    } else if (event.type === 'customer.subscription.deleted') {
      applyStripePaidState(user, object, false);
      user.subscriptionStatus = object.status || 'canceled';
    } else if (event.type === 'invoice.payment_succeeded') {
      applyStripePaidState(user, object, true);
    } else if (event.type === 'invoice.payment_failed') {
      user.subscriptionStatus = 'past_due';
      user.updatedAt = new Date().toISOString();
    }
    saveUsers(db);
  }

  return json(res, 200, { received: true });
}

function json(res, status, body, extraHeaders = {}) {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
}


const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg'
};

function defaultHeaders(headers = {}) {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; audio-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    ...headers
  };
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, defaultHeaders(headers));
  res.end(body);
}

function secureCookieSuffix(req) {
  const proto = req.headers['x-forwarded-proto'] || '';
  return (IS_PRODUCTION || proto === 'https') ? '; Secure' : '';
}

function readRawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 16 * 1024) {
  const raw = await readRawBody(req, limit);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw new Error('invalid json'); }
}


async function handleAuth(req, res, pathname) {
  if (pathname === '/api/me') {
    return json(res, 200, { user: publicUser(currentUser(req)), paid: isPaid(currentUser(req)) });
  }

  if (pathname === '/api/auth/login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const data = await readJson(req);
    const email = String(data.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'email is invalid' });
    const db = loadUsers();
    let user = db.users.find(u => u.email === email);
    if (!user) {
      user = { id: crypto.randomUUID(), email, plan: 'free', subscriptionStatus: 'inactive', createdAt: new Date().toISOString() };
      db.users.push(user);
      saveUsers(db);
    }
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, user.id);
    return json(res, 200, { user: publicUser(user), paid: isPaid(user) }, { 'set-cookie': 'bb_session=' + encodeURIComponent(sid) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000' + secureCookieSuffix(req) });
  }

  if (pathname === '/api/auth/logout') {
    const sid = parseCookies(req).bb_session;
    if (sid) sessions.delete(sid);
    return json(res, 200, { ok: true }, { 'set-cookie': 'bb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }

  return false;
}

async function handleBilling(req, res, pathname) {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'login required' });

  if (pathname === '/api/billing/checkout') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_PRICE_ID) {
      return json(res, 200, { mode: 'demo', message: 'Stripe未設定です。STRIPE_SECRET_KEY と STRIPE_PRICE_ID を .env に入れると決済画面へ進めます。' });
    }
    const base = appBaseUrl(req);
    const session = await stripeRequest('/v1/checkout/sessions', {
      mode: 'subscription',
      'line_items[0][price]': process.env.STRIPE_PRICE_ID,
      'line_items[0][quantity]': '1',
      success_url: base + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: base + '/?checkout=cancel',
      client_reference_id: user.id,
      customer_email: user.email,
      'metadata[userId]': user.id,
      allow_promotion_codes: 'true'
    });
    return json(res, 200, { mode: 'stripe', url: session.url, id: session.id });
  }

  if (pathname === '/api/billing/portal') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!process.env.STRIPE_SECRET_KEY) {
      return json(res, 200, { mode: 'demo', message: 'Stripe未設定です。STRIPE_SECRET_KEY を .env に入れると契約管理画面へ進めます。' });
    }
    if (!user.stripeCustomerId) {
      return json(res, 400, { error: 'Stripeのお客様IDがまだありません。先に有料プラン登録を完了してください。' });
    }
    const base = appBaseUrl(req);
    const session = await stripeRequest('/v1/billing_portal/sessions', {
      customer: user.stripeCustomerId,
      return_url: base + '/?v=v41-billing-portal'
    });
    return json(res, 200, { mode: 'stripe', url: session.url, id: session.id });
  }

  if (pathname === '/api/billing/verify-session') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url, appBaseUrl(req));
    const sessionId = String(url.searchParams.get('session_id') || '');
    if (!sessionId.startsWith('cs_')) return json(res, 400, { error: 'session_id is invalid' });
    const session = await stripeGet('/v1/checkout/sessions/' + encodeURIComponent(sessionId));
    if (session.client_reference_id !== user.id && session.metadata?.userId !== user.id) {
      return json(res, 403, { error: 'session does not belong to current user' });
    }
    if (session.status === 'complete' || session.payment_status === 'paid') {
      const db = loadUsers();
      const stored = db.users.find(u => u.id === user.id);
      if (!stored) return json(res, 404, { error: 'user not found' });
      stored.plan = 'pro';
      stored.subscriptionStatus = 'active';
      stored.stripeCustomerId = session.customer || stored.stripeCustomerId || null;
      stored.stripeSubscriptionId = session.subscription || stored.stripeSubscriptionId || null;
      stored.updatedAt = new Date().toISOString();
      saveUsers(db);
      return json(res, 200, { user: publicUser(stored), paid: true });
    }
    return json(res, 200, { user: publicUser(user), paid: isPaid(user), status: session.status, payment_status: session.payment_status });
  }

  if (pathname === '/api/billing/demo-activate') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const db = loadUsers();
    const stored = db.users.find(u => u.id === user.id);
    if (!stored) return json(res, 404, { error: 'user not found' });
    stored.plan = 'pro';
    stored.subscriptionStatus = 'active';
    stored.subscriptionUntil = null;
    stored.updatedAt = new Date().toISOString();
    saveUsers(db);
    return json(res, 200, { user: publicUser(stored), paid: true });
  }

  return false;
}

async function handleTts(req, res) {
  if (req.method !== 'POST') {
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }), { 'content-type': 'application/json; charset=utf-8' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return send(res, 500, JSON.stringify({ error: 'OPENAI_API_KEY is not set on the server' }), { 'content-type': 'application/json; charset=utf-8' });
  }

  try {
    const data = await readJson(req);
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) {
      return send(res, 400, JSON.stringify({ error: 'text is required' }), { 'content-type': 'application/json; charset=utf-8' });
    }

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice: process.env.OPENAI_TTS_VOICE || 'cedar',
        input: text,
        instructions: process.env.OPENAI_TTS_INSTRUCTIONS || '日本語のスポーツ実況アナウンサーのように、明るく臨場感を持って読み上げてください。',
        response_format: 'mp3'
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return send(res, response.status, JSON.stringify({ error: 'OpenAI TTS failed', detail: errorText }), { 'content-type': 'application/json; charset=utf-8' });
    }

    const audio = Buffer.from(await response.arrayBuffer());
    send(res, 200, audio, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store'
    });
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message || 'tts error' }), { 'content-type': 'application/json; charset=utf-8' });
  }
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { urlPath = '/'; }
  if (urlPath === '/' || urlPath === '/baseball-mobile.html') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(path.normalize(PUBLIC_DIR))) {
    return send(res, 403, 'forbidden', { 'content-type': 'text/plain; charset=utf-8' });
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return send(res, 404, 'not found: ' + urlPath, { 'content-type': 'text/plain; charset=utf-8' });
    }
    send(res, 200, data, {
      'content-type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': urlPath.endsWith('.html') || urlPath.endsWith('.js') ? 'no-store' : 'public, max-age=3600'
    });
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  try {
    if (pathname === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION || 'v45-tts-test-fix', time: new Date().toISOString() });
    if (pathname === '/api/me' || pathname.startsWith('/api/auth/')) return handleAuth(req, res, pathname);
    if (pathname === '/api/stripe/webhook') return handleStripeWebhook(req, res);
    if (pathname.startsWith('/api/billing/')) return handleBilling(req, res, pathname);
    if (pathname === '/api/tts') return handleTts(req, res);
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message || 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('http://' + shownHost + ':' + PORT + '/');
});

