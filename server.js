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
const VIEW_GAMES_FILE = path.join(DATA_DIR, 'view-games.json');
const DEMO_GAME_LIMIT = 2;
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

function loadViewGames() {
  try { return JSON.parse(fs.readFileSync(VIEW_GAMES_FILE, 'utf8')); }
  catch { return { games: {} }; }
}

function saveViewGames(db) {
  fs.writeFileSync(VIEW_GAMES_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function makeViewerToken() {
  return crypto.randomBytes(12).toString('base64url');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email || user.loginId,
    plan: user.plan || 'free',
    subscriptionStatus: user.subscriptionStatus || 'inactive',
    subscriptionUntil: user.subscriptionUntil || null,
    demoGamesUsed: Number(user.demoGamesUsed || 0),
    demoGamesLimit: DEMO_GAME_LIMIT
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

  if (pathname === '/api/auth/register') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const data = await readJson(req);
    const loginId = String(data.loginId || data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(loginId) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginId)) return json(res, 400, { error: 'ログインIDは3文字以上で入力してください' });
    if (!/^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{9,}$/.test(password)) return json(res, 400, { error: 'パスワードは英字と数字を両方含む9文字以上で入力してください' });
    const db = loadUsers();
    if (db.users.find(u => (u.loginId || u.email) === loginId)) return json(res, 409, { error: 'このログインIDは登録済みです。ログインしてください' });
    const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginId) ? loginId : loginId + '@team.local';
    const user = { id: crypto.randomUUID(), loginId, email, passwordHash: hashPassword(password), plan: 'free', subscriptionStatus: 'inactive', demoGamesUsed: 0, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveUsers(db);
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, user.id);
    return json(res, 200, { user: publicUser(user), paid: false }, { 'set-cookie': 'bb_session=' + encodeURIComponent(sid) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000' + secureCookieSuffix(req) });
  }

  if (pathname === '/api/auth/trial') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const db = loadUsers();
    const token = crypto.randomBytes(4).toString('hex');
    const loginId = 'trial-' + token;
    const user = { id: crypto.randomUUID(), loginId, email: loginId + '@trial.local', passwordHash: '', plan: 'free', subscriptionStatus: 'inactive', demoGamesUsed: 0, trial: true, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveUsers(db);
    const sid = crypto.randomBytes(32).toString('hex');
    sessions.set(sid, user.id);
    return json(res, 200, { user: publicUser(user), paid: false }, { 'set-cookie': 'bb_session=' + encodeURIComponent(sid) + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000' + secureCookieSuffix(req) });
  }
  if (pathname === '/api/auth/login') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const data = await readJson(req);
    const loginId = String(data.loginId || data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (!/^[a-z0-9._-]{3,40}$/.test(loginId) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loginId)) return json(res, 400, { error: 'ログインIDは3文字以上で入力してください' });
    if (password.length < 4) return json(res, 400, { error: 'パスワードは4文字以上で入力してください' });
    const db = loadUsers();
    let user = db.users.find(u => (u.loginId || u.email) === loginId);
    if (!user) {
      return json(res, 401, { error: '登録がありません。初めて利用する場合は新規登録してください' });
    } else if (user.passwordHash) {
      if (!verifyPassword(password, user.passwordHash)) return json(res, 401, { error: 'ログインIDまたはパスワードが違います' });
    } else {
      user.loginId = user.loginId || loginId;
      user.passwordHash = hashPassword(password);
      user.updatedAt = new Date().toISOString();
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

async function handleDemoGame(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'login required' });
  if (isPaid(user)) return json(res, 200, { ok: true, paid: true, user: publicUser(user), demoRemaining: null });
  const db = loadUsers();
  const stored = db.users.find(u => u.id === user.id);
  if (!stored) return json(res, 404, { error: 'user not found' });
  const used = Number(stored.demoGamesUsed || 0);
  if (used >= DEMO_GAME_LIMIT) {
    return json(res, 402, { error: '無料お試しは2試合までです。有料プラン登録後に続けて利用できます。', demoRemaining: 0, user: publicUser(stored), paid: false });
  }
  stored.demoGamesUsed = used + 1;
  stored.updatedAt = new Date().toISOString();
  saveUsers(db);
  return json(res, 200, { ok: true, paid: false, user: publicUser(stored), demoRemaining: Math.max(0, DEMO_GAME_LIMIT - stored.demoGamesUsed) });
}
async function handleBilling(req, res, pathname) {
  const user = currentUser(req);
  if (!user) return json(res, 401, { error: 'login required' });

  if (pathname === '/api/billing/checkout') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await readJson(req).catch(() => ({}));
    const plan = ['monthly', 'yearly', 'lifetime'].includes(body.plan) ? body.plan : 'monthly';
    const priceMap = {
      monthly: process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_ID,
      yearly: process.env.STRIPE_YEARLY_PRICE_ID,
      lifetime: process.env.STRIPE_LIFETIME_PRICE_ID
    };
    const priceId = priceMap[plan];
    if (!process.env.STRIPE_SECRET_KEY || !priceId) {
      return json(res, 200, { mode: 'demo', message: 'Stripe未設定です。選択したプランのPrice IDとSTRIPE_SECRET_KEYを環境変数に入れると決済画面へ進めます。' });
    }
    const base = appBaseUrl(req);
    const session = await stripeRequest('/v1/checkout/sessions', {
      mode: plan === 'lifetime' ? 'payment' : 'subscription',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: base + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: base + '/?checkout=cancel',
      client_reference_id: user.id,
      customer_email: user.email,
      'metadata[userId]': user.id,
      'metadata[plan]': plan,
      allow_promotion_codes: 'true'
    });
    updateStoredUser(user.id, stored => {
      stored.pendingStripeSessionId = session.id;
      stored.updatedAt = new Date().toISOString();
    });
    return json(res, 200, { mode: 'stripe', url: session.url, id: session.id, plan });
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
    updateStoredUser(user.id, stored => {
      stored.pendingStripeSessionId = session.id;
      stored.updatedAt = new Date().toISOString();
    });
    return json(res, 200, { mode: 'stripe', url: session.url, id: session.id });
  }

  if (pathname === '/api/billing/verify-session') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const url = new URL(req.url, appBaseUrl(req));
    const sessionId = String(url.searchParams.get('session_id') || user.pendingStripeSessionId || '');
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
      stored.pendingStripeSessionId = null;
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
  if (req.method !== 'POST' && req.method !== 'GET') {
    return send(res, 405, JSON.stringify({ error: 'method not allowed' }), { 'content-type': 'application/json; charset=utf-8' });
  }

  try {
    const data = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://localhost').searchParams) : await readJson(req);
    const text = String(data.text || '').trim().slice(0, 1000);
    if (!text) {
      return send(res, 400, JSON.stringify({ error: 'text is required' }), { 'content-type': 'application/json; charset=utf-8' });
    }

    const provider = String(process.env.TTS_PROVIDER || 'openai').toLowerCase();
    let response;

    if (provider === 'elevenlabs') {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const voiceId = process.env.ELEVENLABS_VOICE_ID;
      if (!apiKey || !voiceId) {
        return send(res, 500, JSON.stringify({ error: 'ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID is not set on the server' }), { 'content-type': 'application/json; charset=utf-8' });
      }
      response = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3_44100_128', {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'accept': 'audio/mpeg',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
          language_code: process.env.ELEVENLABS_LANGUAGE_CODE || 'ja',
          voice_settings: {
            stability: Number(process.env.ELEVENLABS_STABILITY || 0.78),
            similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.92),
            style: Number(process.env.ELEVENLABS_STYLE || 0.04),
            use_speaker_boost: true
          }
        })
      });
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return send(res, 500, JSON.stringify({ error: 'OPENAI_API_KEY is not set on the server' }), { 'content-type': 'application/json; charset=utf-8' });
      }
      response = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + apiKey,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
          voice: process.env.OPENAI_TTS_VOICE || 'cedar',
          input: text,
          instructions: process.env.OPENAI_TTS_INSTRUCTIONS || '落ち着いた男性の日本語スポーツ実況アナウンサーとして、会話のように自然で滑らかに読んでください。短い速報文でも機械的に区切らず、聞き取りやすいテンポで、明るさと臨場感を少し加えてください。',
          response_format: 'mp3'
        })
      });
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return send(res, response.status, JSON.stringify({ error: provider + ' TTS failed', detail: errorText }), { 'content-type': 'application/json; charset=utf-8' });
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

function ttsStatus() {
  const provider = String(process.env.TTS_PROVIDER || 'openai').toLowerCase();
  const ready = provider === 'elevenlabs'
    ? !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID)
    : !!process.env.OPENAI_API_KEY;
  return {
    provider,
    ready,
    label: provider === 'elevenlabs' ? 'ElevenLabs TTS' : 'サーバーTTS'
  };
}

function viewerCookie(req, res) {
  const cookies = parseCookies(req);
  let id = cookies.bb_viewer_id;
  if (!id || !/^[A-Za-z0-9_-]{12,80}$/.test(id)) {
    id = crypto.randomBytes(12).toString('base64url');
    res.setHeader('set-cookie', 'bb_viewer_id=' + encodeURIComponent(id) + '; Path=/; Max-Age=31536000; SameSite=Lax' + secureCookieSuffix(req));
  }
  return id;
}

function compactGameState(state) {
  const copy = JSON.parse(JSON.stringify(state || {}));
  copy.snap = [];
  return copy;
}

async function handleViewGame(req, res, pathname) {
  if (pathname === '/api/view-game/publish') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const user = currentUser(req);
    if (!isPaid(user)) return json(res, 403, { error: '有料アカウントのみ閲覧URLを発行できます' });
    const body = await readJson(req, 768 * 1024);
    const state = compactGameState(body.state);
    const usersDb = loadUsers();
    const stored = usersDb.users.find(u => u.id === user.id);
    if (!stored) return json(res, 401, { error: 'login required' });
    if (!stored.viewerToken) {
      stored.viewerToken = makeViewerToken();
      saveUsers(usersDb);
    }
    const db = loadViewGames();
    db.games[stored.viewerToken] = {
      token: stored.viewerToken,
      ownerId: user.id,
      state,
      limit: null,
      viewers: (db.games[stored.viewerToken] && db.games[stored.viewerToken].viewers) || {},
      updatedAt: new Date().toISOString()
    };
    saveViewGames(db);
    return json(res, 200, { ok: true, token: stored.viewerToken, url: appBaseUrl(req) + '/view.html?game=' + encodeURIComponent(stored.viewerToken), limit: null });
  }

  if (pathname === '/api/view-game') {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const token = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    const db = loadViewGames();
    const game = db.games[token];
    if (!game) return json(res, 404, { error: '閲覧URLが見つかりません' });
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    game.viewers = game.viewers || {};
    Object.keys(game.viewers).forEach(id => { if (now - Number(game.viewers[id] || 0) > day) delete game.viewers[id]; });
    const viewerId = viewerCookie(req, res);
    game.viewers[viewerId] = now;
    saveViewGames(db);
    return json(res, 200, { ok: true, state: game.state, updatedAt: game.updatedAt, viewers: Object.keys(game.viewers).length, limit: null });
  }

  return json(res, 404, { error: 'not found' });
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
    if (pathname === '/api/health') return json(res, 200, { ok: true, version: process.env.APP_VERSION || 'v105-app-trial-button', time: new Date().toISOString() });
    if (pathname === '/api/me' || pathname.startsWith('/api/auth/')) return await handleAuth(req, res, pathname);
    if (pathname === '/api/stripe/webhook') return await handleStripeWebhook(req, res);
    if (pathname === '/api/demo/new-game') return await handleDemoGame(req, res);
    if (pathname.startsWith('/api/billing/')) return await handleBilling(req, res, pathname);
    if (pathname === '/api/view-game/publish' || pathname === '/api/view-game') return await handleViewGame(req, res, pathname);
    if (pathname === '/api/tts/status') return json(res, 200, ttsStatus());
    if (pathname === '/api/tts') return await handleTts(req, res);
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message || 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('http://' + shownHost + ':' + PORT + '/');
});

























