import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { issueKeyFromLink } from './config.js';
import { encryptTokens } from './crypto.js';
import { normalizeTokens } from './worker.js';

// Expected, user-fixable submit refusals raised by office_jira_submit (never provider or SQL internals).
const SUBMIT_ERRORS = {
  jira_already_claimed: 'Coins for this ticket have already been claimed.',
  jira_already_awarded: 'You already earned coins for this ticket.',
  jira_job_active: 'This ticket is already being checked.',
  jira_not_connected: 'Connect your Jira account first.',
};

// User-fixable OAuth callback failures. Plain text, no identities: never reveal which Office account holds a Jira identity.
const CALLBACK_ERRORS = {
  jira_identity_taken: 'This Jira account is already connected to a different Jakogami account. Sign out of Atlassian (or use a private window), sign in as your own Jira user, then connect again. To move it, disconnect Jira from the other Office account first.',
  jira_connect_invalid: 'This Jakogami account is not allowed to connect Jira. Its profile role must be employee or super_admin.',
  jira_invalid_site: 'The Jira account you approved does not have access to the configured Jira site. Choose the correct site on the Atlassian consent screen, then connect again.',
  jira_missing_permissions: 'Jira read permissions were not granted. Connect again and accept the requested access.',
};

function makeJiraRoutes({ config, store, jira, sessionClient, lock, now = Date.now }) {
  const routes = Router(), states = new Map(), limits = new Map();
  const cookieOptions = { httpOnly: true, secure: config.origin.startsWith('https:'), sameSite: 'lax', path: '/api/jira/callback', maxAge: 600000 };
  const hash = value => createHash('sha256').update(value).digest();
  function ready(req, res, next) {
    if (!config.ready) return res.status(503).json({ error: 'Jira connection setup is required. See .skills/jira-rewards/SKILL.md.', code: 'jira_setup_required' });
    next();
  }
  function account(req, res, next) {
    if (req.get('X-Office-Account') !== req.profile.id) return res.status(409).json({ error: 'Signed-in account changed. Reload and try again.', code: 'account_changed' });
    next();
  }
  function rate(req, res, next) {
    const time = now();
    for (const [id, value] of limits) if (value.until <= time) limits.delete(id);
    const current = limits.get(req.profile.id) || { count: 0, until: time + 60000 };
    current.count++; limits.set(req.profile.id, current);
    if (limits.size > 10000 || current.count > 10) return res.status(429).json({ error: 'Please wait a minute before submitting more Jira requests.' });
    next();
  }
  async function rpc(req, name, params = {}) {
    const db = sessionClient(req.accessToken);
    if (!db) throw new Error('jira_setup_required');
    const { data, error } = await db.rpc(name, params);
    if (error) throw Object.assign(new Error('jira_setup_required'), { code: error.code, detail: error.message });
    return data;
  }
  routes.get('/jira', account, async (req, res) => {
    if (!config.ready) return res.json({ configured: false, aiConfigured: config.aiReady, connected: false, jobs: [], site: config.site || null });
    const data = await rpc(req, 'office_jira_status');
    res.json({ ...data, configured: true, aiConfigured: config.aiReady, site: config.site });
  });
  routes.post('/jira/setup', ready, account, rate, async (req, res) => {
    if (req.profile.role !== 'super_admin') return res.status(403).json({ error: 'Administrator access is required.' });
    try { await rpc(req, 'office_jira_bootstrap', { p_secret: config.signingSecret }); }
    catch (error) {
      const code = /^jira_[a-z_]{1,60}$/.test(error.detail || '') ? error.detail : error.code === '42501' ? 'not_super_admin_in_database' : 'setup_failed';
      console.warn('[jira] Secure rewards setup failed:', code, error.code || '');
      return res.status(503).json({ error: `Secure rewards setup failed (${code}). See .skills/jira-rewards/SKILL.md troubleshooting.`, code });
    }
    res.json({ ok: true });
  });
  routes.post('/jira/connect', ready, account, rate, (req, res) => {
    const time = now();
    for (const [state, value] of states) if (value.until <= time) states.delete(state);
    if (states.size >= 10000) return res.status(429).json({ error: 'Please try connecting later.' });
    const state = randomBytes(32).toString('base64url');
    states.set(state, { userId: req.profile.id, until: time + 600000 });
    res.cookie('officeJiraState', state, cookieOptions);
    const url = new URL('https://auth.atlassian.com/authorize');
    for (const [key, value] of Object.entries({
      audience: 'api.atlassian.com', client_id: config.clientId, redirect_uri: config.callback,
      scope: 'read:jira-work read:jira-user offline_access', state, response_type: 'code', prompt: 'consent',
    })) url.searchParams.set(key, value);
    res.json({ url: url.href });
  });
  routes.get('/jira/callback', ready, async (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const saved = states.get(state);
    states.delete(state);
    const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('officeJiraState='))?.slice('officeJiraState='.length) || '';
    res.clearCookie('officeJiraState', { ...cookieOptions, maxAge: undefined });
    if (!saved || saved.until <= now() || saved.userId !== req.profile.id
      || !timingSafeEqual(hash(cookie), hash(state)) || typeof req.query.code !== 'string' || req.query.code.length > 4096) {
      return res.status(400).send('Jira connection expired or was denied. Return to Jakogami and connect again.');
    }
    try {
      await lock(req.profile.id, async () => {
        const tokens = normalizeTokens(await jira.exchange(req.query.code));
        const identity = await jira.identity(tokens.access_token);
        await store('connect', { userId: req.profile.id, ...identity, encryptedTokens: encryptTokens(tokens, config.signingSecret, req.profile.id) });
      });
      res.redirect(303, '/?jira=connected');
    } catch (error) {
      // Codes only (e.g. jira_invalid_site, jira_storage_unavailable + Postgres code); never tokens or payloads.
      console.warn('[jira] OAuth callback failed:', error?.message, error?.code || error?.status || '', error?.reason || '');
      const known = CALLBACK_ERRORS[error?.reason] || CALLBACK_ERRORS[error?.message];
      if (known) return res.status(409).send(known);
      res.status(503).send('Jira connection could not be completed. Check site permissions and reward database setup, then connect again.');
    }
  });
  routes.post('/jira/submit', ready, account, rate, async (req, res) => {
    if (!req.is('application/json') || Object.keys(req.body || {}).some(key => key !== 'link')) return res.status(400).json({ error: 'Provide a Jira issue link only.' });
    let key;
    try { key = issueKeyFromLink(req.body?.link, config.site); }
    catch (_) { return res.status(400).json({ error: 'Use a /browse/PROJECT-123 link from your configured Jira site.' }); }
    let data;
    try { data = await rpc(req, 'office_jira_submit', { p_issue_key: key }); }
    catch (error) {
      const message = SUBMIT_ERRORS[error.detail];
      if (!message) throw error;
      return res.status(409).json({ error: message, code: error.detail });
    }
    res.status(202).json(data);
  });
  routes.post('/jira/disconnect', ready, account, rate, async (req, res) => {
    await lock(req.profile.id, () => rpc(req, 'office_jira_disconnect'));
    res.json({ ok: true });
  });
  routes.use('/jira', (error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(503).json({ error: 'Jira rewards are unavailable. Check the migration, secure initialization, and connection setup.', code: 'jira_setup_required' });
  });
  return routes;
}

export { makeJiraRoutes };
