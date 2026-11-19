import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeApi } from './api.js';

// Production server (`npm start`, used on Render): built app and authenticated BFF only.
// Hosts like Render pass the port in $PORT and expect the server on 0.0.0.0.
const root = fileURLToPath(new URL('..', import.meta.url));
const dist = root + 'dist';
if (existsSync(root + '.env')) process.loadEnvFile(root + '.env'); // local runs; Render sets real env vars
if (!existsSync(dist + '/index.html')) { console.error('dist/ is missing: run `npm run build` first'); process.exit(1); }

const app = express();
const api = makeApi(process.env);
app.disable('x-powered-by');
app.use('/api', api);
app.use(express.static(dist, {
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  },
}));
app.get('/{*any}', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(dist + '/index.html');
});

const port = Number(process.env.PORT) || 4173;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Jakogami on http://localhost:${port} (Supabase ${process.env.SUPABASE_URL ? 'configured' : 'not configured'})`);
  api.startBackgroundJobs();
});
api.attachRealtime(server);
server.on('close', () => api.stopBackgroundJobs());
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  api.stopBackgroundJobs();
  server.close();
});
