import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Router } from 'express';
import WebSocket from 'ws';

const ACCESS_COOKIE = 'officeAccess', REFRESH_COOKIE = 'officeRefresh';
const REFRESH_LIFETIME = 60 * 60 * 24 * 7;
const LOCAL_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://127.0.0.1:5173', 'http://127.0.0.1:4173'];

// Never sign into the service-role database client: each auth operation owns its client.
function makeAuthClient(env) {
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY;
  if (!env.SUPABASE_URL || !key) return null;
  return createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: WebSocket },
  });
}

function cookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { result[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1)); } catch (_) {}
  }
  return result;
}

function makeAuth(env, db, { clientFactory = () => makeAuthClient(env), now = Date.now } = {}) {
  const routes = Router(), attempts = new Map(), refreshes = new Map();
  const secure = env.NODE_ENV === 'production' || !!env.RENDER || /^https:/.test(env.APP_ORIGIN || '');
  const origins = env.APP_ORIGIN ? [new URL(env.APP_ORIGIN).origin] : (secure ? [] : LOCAL_ORIGINS);
  const cookieOptions = { httpOnly: true, secure, sameSite: 'lax', path: '/api' };
  const clear = res => {
    res.clearCookie(ACCESS_COOKIE, cookieOptions);
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
  };
  const write = (res, session) => {
    res.cookie(ACCESS_COOKIE, session.access_token, { ...cookieOptions, maxAge: Math.max(1, session.expires_in || 3600) * 1000 });
    res.cookie(REFRESH_COOKIE, session.refresh_token, { ...cookieOptions, maxAge: REFRESH_LIFETIME * 1000 });
  };
  const deny = (res, status = 401, error = 'Please sign in again.') => {
    clear(res);
    return res.status(status).json({ error });
  };
  const hash = token => createHash('sha256').update(token).digest('hex');

  function originGuard(req, res, next) {
    // APP_ORIGIN is explicit; never derive trust from Host or forwarded request headers.
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-origin request denied.' });
    if (req.headers.origin && !origins.includes(req.headers.origin)) return res.status(403).json({ error: 'Request origin is not allowed.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !origins.includes(req.headers.origin)) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    next();
  }

  function throttle(req, res, next) {
    // Do not trust arbitrary forwarded IPs; use a higher shared-proxy cap plus an account-specific cap.
    const ip = req.socket.remoteAddress || 'unknown', time = now();
    for (const [ip, entry] of attempts) if (entry.until <= time) attempts.delete(ip);
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    for (const [key, limit] of [[`ip:${ip}`, 120], [`account:${ip}:${hash(email)}`, 10]]) {
      if (!attempts.has(key) && attempts.size >= 10000) return res.status(429).json({ error: 'Please try again later.' });
      const entry = attempts.get(key) || { count: 0, until: time + 60000 };
      entry.count++; attempts.set(key, entry);
      if (entry.count > limit) {
        res.set('Retry-After', String(Math.ceil((entry.until - time) / 1000)));
        return res.status(429).json({ error: 'Too many sign-in attempts. Please wait a minute.' });
      }
    }
    next();
  }

  async function profile(user) {
    const { data, error } = await db.from('profiles').select('id, full_name, role').eq('id', user.id).maybeSingle();
    if (error) throw new Error('Profile lookup failed');
    if (!data || !['employee', 'super_admin'].includes(data.role)) return null;
    let fullName = (data.full_name || '').trim();
    // Some dashboard profiles store only a first name; the employee record has separate name fields.
    // Display-name enrichment is optional and must not change access decisions or update account data.
    if (!/\s/.test(fullName)) {
      try {
        const { data: employee, error: employeeError } = await db.from('employees')
          .select('first_name, last_name').eq('id', user.id).maybeSingle();
        if (!employeeError && employee?.first_name?.trim() && employee?.last_name?.trim()) {
          fullName = `${employee.first_name.trim()} ${employee.last_name.trim()}`;
        }
      } catch (_) {}
    }
    return { id: data.id, full_name: fullName, role: data.role };
  }

  async function refresh(token) {
    const time = now(), key = hash(token);
    for (const [id, entry] of refreshes) if (entry.until <= time) refreshes.delete(id);
    // Supabase rotates refresh tokens; coalesce parallel requests and allow a brief overlap.
    if (!refreshes.has(key)) {
      if (refreshes.size >= 1000) throw new Error('Refresh capacity exceeded');
      const entry = { until: Infinity, invalidated: false };
      entry.promise = clientFactory().auth.refreshSession({ refresh_token: token }).then(result => {
        entry.until = now() + 10000;
        entry.rotatedHash = result.data?.session?.refresh_token ? hash(result.data.session.refresh_token) : null;
        return result;
      }, error => {
        entry.until = now() + 10000;
        throw error;
      });
      refreshes.set(key, entry);
    }
    const entry = refreshes.get(key), result = await entry.promise;
    return entry.invalidated ? { error: true } : { ...result, isInvalidated: () => entry.invalidated };
  }

  async function requireSession(req, res, next) {
    const jar = cookies(req), client = clientFactory();
    if (!client) return res.status(503).json({ error: 'Authentication is not configured.' });
    let user;
    if (jar[ACCESS_COOKIE]) {
      const result = await client.auth.getUser(jar[ACCESS_COOKIE]);
      if (!result.error) user = result.data?.user;
    }
    if (!user && jar[REFRESH_COOKIE]) {
      const { data, error, isInvalidated } = await refresh(jar[REFRESH_COOKIE]);
      if (error || !data?.session) return deny(res);
      // A refresh response alone is not our identity check.
      const verified = await client.auth.getUser(data.session.access_token);
      if (verified.error || !verified.data?.user) return deny(res);
      user = verified.data.user;
      const signedIn = await profile(user);
      if (!signedIn) return deny(res, 403, 'This account does not have Jakogami access.');
      if (isInvalidated()) return deny(res);
      write(res, data.session);
      req.profile = signedIn;
      req.accessToken = data.session.access_token;
      return next();
    }
    if (!user) return deny(res);
    const signedIn = await profile(user);
    if (!signedIn) return deny(res, 403, 'This account does not have Jakogami access.');
    req.profile = signedIn;
    req.accessToken = jar[ACCESS_COOKIE];
    next();
  }

  routes.post('/login', throttle, async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use a JSON request.' });
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || email.length > 254 || !password || password.length > 1024) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }
    const client = clientFactory();
    if (!client) return res.status(503).json({ error: 'Authentication is not configured.' });
    const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) {
      if (error.code === 'invalid_credentials'
        || (error.status === 400 && error.message === 'Invalid login credentials')) {
        return deny(res, 401, 'Email or password is incorrect.');
      }
      if (error.status === 429) {
        return res.status(429).json({ error: 'Sign-in is temporarily rate limited. Please wait and try again.' });
      }
      if (error.code === 'invalid_api_key' || [401, 403].includes(error.status)) {
        return res.status(503).json({
          error: 'Jakogami could not authenticate with Supabase. The configured project URL and API key must belong to the same project.',
          code: 'auth_configuration_error',
        });
      }
      return res.status(503).json({
        error: 'Supabase sign-in is temporarily unavailable. Your credentials could not be checked.',
        code: 'auth_service_unavailable',
      });
    }
    if (!data?.session) return res.status(503).json({
      error: 'Supabase did not return a sign-in session. Please try again.',
      code: 'auth_service_unavailable',
    });
    const verified = await client.auth.getUser(data.session.access_token);
    if (verified.error || !verified.data?.user) return deny(res);
    const signedIn = await profile(verified.data.user);
    if (!signedIn) return deny(res, 403, 'This account does not have Jakogami access.');
    write(res, data.session);
    res.json({ profile: signedIn });
  });
  routes.get('/session', requireSession, (req, res) => res.json({ profile: req.profile }));
  routes.post('/logout', async (req, res) => {
    const jar = cookies(req);
    clear(res);
    const client = clientFactory();
    let access = jar[ACCESS_COOKIE];
    // An expired access cookie must not turn logout into a browser-only token deletion.
    if (client && jar[REFRESH_COOKIE]) {
      const verified = access ? await client.auth.getUser(access) : { error: true };
      if (verified.error || !verified.data?.user) {
        const result = await refresh(jar[REFRESH_COOKIE]);
        access = result.data?.session?.access_token;
        if (result.error && ![400, 401, 403].includes(result.error.status)) {
          return res.status(503).json({ error: 'Local session cleared; account session revocation is temporarily unavailable.' });
        }
      }
    }
    // Invalidate any overlap result for this refresh token before revoking this session.
    if (jar[REFRESH_COOKIE]) {
      const key = hash(jar[REFRESH_COOKIE]);
      for (const [id, entry] of refreshes) {
        if (id === key || entry.rotatedHash === key) { entry.invalidated = true; refreshes.delete(id); }
      }
    }
    if (client && access) {
      const { error } = await client.auth.admin.signOut(access, 'local');
      if (error && ![401, 403, 404].includes(error.status)) {
        return res.status(503).json({ error: 'Local session cleared; account session revocation is temporarily unavailable.' });
      }
    }
    res.status(204).end();
  });
  // The duel socket's handshake (server/duel.js): the same origin allow-list and access cookie as the API, but no
  // refresh (a socket cannot set cookies; the browser calls /api/auth/session first). The client connects with
  // the WebSocket transport only, so the browser always sends Origin. Returns the allowed profile, or null.
  async function verifySocket(headers = {}) {
    if (headers['sec-fetch-site'] === 'cross-site' || !headers.origin || !origins.includes(headers.origin)) return null;
    const token = cookies({ headers })[ACCESS_COOKIE], client = token ? clientFactory() : null;
    if (!client) return null;
    const result = await client.auth.getUser(token);
    if (result.error || !result.data?.user) return null;
    return profile(result.data.user);
  }

  return { originGuard, requireSession, routes, verifySocket };
}

export { makeAuth, makeAuthClient };
