import express from 'express';
import { makeAuth } from './auth.js';
import { attachDuel } from './duel.js';
import { attendanceRoutes } from './routes/attendance.js';
import { duelRoutes } from './routes/duel.js';
import { employeeRoutes } from './routes/employees.js';
import { marketplaceRoutes } from './routes/marketplace.js';
import { makeSessionSupabase, makeSupabase } from './supabase.js';
import { jiraConfig } from './jira/config.js';
import { makeWorkerStore } from './jira/crypto.js';
import { makeJiraClient } from './jira/client.js';
import { makeJiraRoutes } from './jira/routes.js';
import { makeJiraWorker, makeUserLock } from './jira/worker.js';

// The BFF (backend for frontend): the only part of the app that talks to Supabase. The browser calls /api/...
// on our own origin and never sees the Supabase URL or keys. Mounted at /api by server/index.js in
// production and by the Vite dev server in development (vite.config.js).
function makeApi(env, dependencies = {}) {
  const api = express(), db = dependencies.db ?? makeSupabase(env);
  const auth = makeAuth(env, db, dependencies);
  const config = jiraConfig(env), lock = makeUserLock();
  const sessionClient = dependencies.marketplaceClientFactory ?? (accessToken => makeSessionSupabase(env, accessToken));
  const store = dependencies.jiraStore ?? makeWorkerStore(db, config.signingSecret || '');
  const jira = dependencies.jiraClient ?? makeJiraClient(config);
  const worker = makeJiraWorker({ config, store, jira, lock });
  let realtime = null;
  api.startBackgroundJobs = () => worker.start();
  api.stopBackgroundJobs = () => { worker.stop(); realtime?.close(); realtime = null; };
  // Duels (server/duel.js) share the app's HTTP server; call once it exists (server/index.js, vite.config.js).
  api.attachRealtime = httpServer => { if (httpServer && !realtime) realtime = attachDuel(httpServer, { verify: auth.verifySocket, db, ...dependencies.duel }); return realtime; };
  api.disable('x-powered-by');
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  api.use((req, res, next) => {
    // Atlassian returns via a top-level cross-site GET. Session + one-use state
    // + HttpOnly browser nonce protect this one callback; mutations keep origin checks.
    if (req.method === 'GET' && req.path === '/jira/callback') return next();
    return auth.originGuard(req, res, next);
  });
  api.use(express.json({ limit: '16kb' }));

  api.get('/health', (req, res) => res.json({ ok: true, supabase: !!db }));
  api.use((req, res, next) => (db ? next() : res.status(503).json({ error: 'Supabase is not configured on the server' })));
  api.use('/auth', auth.routes);
  api.use(auth.requireSession);
  api.use(employeeRoutes(db));
  api.use(attendanceRoutes(db));
  api.use(marketplaceRoutes(sessionClient));
  api.use(duelRoutes(sessionClient));
  api.use(makeJiraRoutes({ config, store, jira, sessionClient, lock }));

  api.use((req, res) => res.status(404).json({ error: 'Not found' }));
  // Never log request bodies, cookie headers or Supabase errors that may contain tokens.
  api.use((err, req, res, next) => {
    console.error('[api] request failed', Number(err.status) || 500);
    if (res.headersSent) return next(err);
    res.status(err.status === 400 ? 400 : 503).json({ error: err.status === 400 ? 'Invalid JSON request.' : 'Service temporarily unavailable.' });
  });
  return api;
}

export { makeApi };
