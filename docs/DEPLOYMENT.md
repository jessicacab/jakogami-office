# Deployment

The app is the built front end (`npm run build` → `dist/`) plus a small Node server, the **BFF** (`server/`). The server serves `dist/` and answers `/api/...`, and it is the only part that talks to Supabase. The browser never sees the Supabase URL or keys. Deploy it as a **Web Service**; a Static Site can't run the API.

## Render: Web Service

| Setting | Value |
|---|---|
| Build command | `npm install && npm run build` |
| Start command | `npm start` (runs `node server/index.js`) |
| Node version | from `.node-version` (22), or set the `NODE_VERSION` environment variable |
| Environment variables | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `APP_ORIGIN` (Render supplies `PORT`) |

The server listens on `0.0.0.0` and on the port in `$PORT`. Duels use a WebSocket at `/api/socket.io` on the same service (Render web services support WebSockets; no extra setting). Chat and Power Slap server attachments are disabled for launch. Without the Supabase variables `/api/health` reports `"supabase": false`; authentication and office data answer 503 rather than opening a demo office.

## Supabase

1. Use the existing dashboard's Supabase project and accounts. Login reads the existing `profiles(id, full_name, role)` table. Login alone needs no migration; Marketplace needs the separate setup below and does not overwrite dashboard data.
2. Keep the existing working project's URL/key in `.env` locally and in Render's environment settings (`SUPABASE_URL` and the existing `SUPABASE_SECRET_KEY` variable). The variable's historical name does not determine the key's privileges. Marketplace uses the signed-in user's session and does not require replacing a working project key with a privileged key. These variables stay server-only: never give them a `VITE_` prefix. An optional `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`) is preferred by the isolated auth and Marketplace clients when supplied; otherwise they reuse the existing configured key.

## Authentication and security

- Set `APP_ORIGIN` to the exact public Office Floor origin, for example `https://office.example.com`, and use HTTPS. It is required in production (including Render); absent it, mutation requests fail closed. Do not set this to the dashboard's origin. Custom local ports also need an explicit `APP_ORIGIN`.
- Without `APP_ORIGIN`, non-production local runs allow only `http://localhost:5173`, `http://localhost:4173`, and the equivalent `127.0.0.1` origins. Production/Render always enables Secure cookies even behind an HTTPS-terminating proxy. The server never trusts `Host`, `X-Forwarded-Host`, or forwarded IPs to authorize origins.
- `/api/auth/login` accepts JSON only; `/api/auth/session` verifies the current user and refreshes expired sessions; `/api/auth/logout` clears cookies and revokes the current Supabase session. Access/refresh tokens never reach browser JavaScript. Employee/attendance endpoints require a verified allowed profile; API responses use `Cache-Control: no-store`.
- Login throttling is in-memory: 10 requests/minute per normalized-email hash + socket IP and 120/minute per socket IP, including successful attempts. Shared reverse proxies share the higher budget because arbitrary forwarded IPs are not trusted; email values are not retained by the limiter. Configure an edge rate limiter for a multi-instance or higher-traffic deployment; the in-process limiter resets on restart. Refresh coalescing is likewise process-local; keep one instance/sticky routing until a shared session strategy is introduced.
- Only existing `profiles.role` values `employee` and `super_admin` are accepted. The shared office-data client is never signed into or assigned a user session. Marketplace gets a separate client per request, with the verified current access token (including after refresh), not a token from an incoming Authorization header.
- **Password policy boundary:** the dashboard reference mentions `employees.password_changed`, but the deployed schema, relation key, mandatory-change semantics, and account-management destination are unconfirmed. Office Floor deliberately does not guess/query that field or lock out otherwise valid users. Password recovery/change remains in the dashboard. If mandatory first-password-change enforcement is required before launch, confirm those details and implement an explicit server-side restriction; this version does not claim to enforce that dashboard-specific flag.
- Marketplace wallets, inventory, and equipment use server-verified identity. An `X-Office-Account` header asserts the account currently displayed by the frontend; it must match the verified session and cannot select an account. Mismatches are rejected before any transaction. New account sign-up remains out of scope.
- The duel socket accepts only a WebSocket handshake whose `Origin` is `APP_ORIGIN` (or a local origin in development) and whose `officeAccess` cookie verifies as an `employee` or `super_admin`. Identity is the verified profile; a browser cannot name another account, report damage or choose its stats. Duel state lives in memory: keep **one instance** (like login throttling); a restart ends running duels without saving a result.
- Sign-out revokes refresh capability for this session; like Supabase generally, an already issued access JWT may remain valid until its expiry. Cookies are cleared immediately; do not treat logout as instantaneous revocation of every copied access token.

## Marketplace setup

1. In the **same Supabase project as the dashboard**, open **SQL Editor → New query**.
2. For a new installation, run `supabase/migrations/202611090001_marketplace.sql` first, then `supabase/migrations/202611090002_marketplace_session_access.sql`, as the project database administrator. If you already ran the first script, **run only the new `202611090002_marketplace_session_access.sql` script**. Copy the entire contents of each applicable file into SQL Editor. Do not paste keys or credentials into SQL.
3. The scripts add only namespaced Marketplace tables, functions, grants, and RLS policies. They use existing `auth.users` and `profiles` identities. Rerunning them does not reset spent coins or remove purchases. The session-access script adds authenticated entry points without changing attendance or opening anonymous access.
4. For the volume 2 items (hoodie, tracksuit, suit, two vests, Obsidian Bulwark, cat, drone, Ember Wisp), also run `supabase/migrations/202611190001_marketplace_items.sql`. It only adds catalog rows and is safe to rerun. Until it is applied, those items show in the shop but buying them fails with "Marketplace catalog changed".
5. For **weapons** (the fourth slot), also run `supabase/migrations/202611190002_marketplace_weapons.sql` after the volume 2 file. It adds the slot, six weapons, and updated equip/snapshot functions, and is safe to rerun. If you ever rerun `202611090001_marketplace.sql`, run the weapons file again afterwards (the original file restores the three-slot functions). Without it, weapons show in the shop but cannot be bought, and everyone duels with fists.
6. Reload Office Floor and open **Marketplace**. Press **Refresh** if it was already open. The first account-state request creates that account's wallet and grants **3,000 coins once**, with a welcome ledger entry. Existing users are initialized lazily; no manual balance insert is needed.
7. Buy a low-cost outfit, verify the balance and inventory, equip it, and reload to check persistence. Sign into another account to verify its collection and balance are independent.

No new key or environment variable is needed beyond the existing server-only Supabase configuration and `APP_ORIGIN`. Restart the running application after updating backend code. A missing session-access script now produces a setup-required message rather than a generic temporary outage.

The tables are `office_market_catalog`, `office_market_wallets`, `office_market_inventory`, `office_market_equipment`, and `office_market_transactions`. Authenticated database clients can read only their own private account data; direct table writes and the original UUID-taking transaction helpers remain restricted. New `office_market_my_state`, `office_market_my_purchase`, and `office_market_my_equip` entry points derive account identity from `auth.uid()` and verify an allowed office profile. Callers cannot select an account UUID. Only equipped cosmetic IDs are shared through `office_market_appearances` with other authenticated office viewers; this read does not create wallets or reveal inventory/balances.

Purchases and equipment changes serialize on the account wallet row. Database prices must match the server's catalog price; stale catalog deployments fail with `catalog_changed` instead of charging an undisclosed price. Keep `src/config/marketplace.js` and the migration's seed aligned when adding items or changing prices.

The welcome balance is not a daily allowance. There are no real-money purchases, refills, or trading. Jira rewards are optional and are described below.

## Duel setup

1. In the **same Supabase project**, after the Marketplace migrations, run `supabase/migrations/202611180001_duel.sql` in **SQL Editor** (copy the whole file). It is additive and rerunnable.
2. It adds `office_duel_matches` (written only by the server's secret key, closed to browsers with RLS and revoked grants) and `office_duel_records(uuid[])`, which returns win/loss/draw totals to signed-in office staff.
3. Restart the app. Sign in with two accounts in two browsers, challenge one from the other, accept, and fight to the end; both records should update.

Without the migration duels still work, but results are not saved (the server logs one warning) and the Duel panel shows a setup notice instead of records. No new environment variable is needed.

## Jira Earn Coins setup (optional)

Jira rewards are verified server-side, credited through an idempotent ledger (one reward per Jira issue), and never accepted from browser-submitted completions. Without the variables below the Earn Coins panel shows a setup message and nothing else changes.

1. Run `supabase/migrations/202611090003_jira_rewards.sql` after the two Marketplace scripts (same SQL Editor flow, rerunnable).
2. Create an Atlassian OAuth 2.0 (3LO) app with scopes `read:jira-work`, `read:jira-user`, `offline_access`, and callback `${APP_ORIGIN}/api/jira/callback`.
3. Set `JIRA_SITE_URL`, `JIRA_OAUTH_CLIENT_ID`, `JIRA_OAUTH_CLIENT_SECRET`, `JIRA_OAUTH_CALLBACK_URL`, `JIRA_REWARD_SIGNING_SECRET` (`openssl rand -hex 32`), `JIRA_AI_ENABLED=true`, `OPENAI_API_KEY`, and `OPENAI_MODEL` in Render's environment. Restart the service.
4. As a `super_admin`, call `POST /api/jira/setup` once to store the signing secret in Supabase Vault.
5. Edit the reward policy row in SQL (rewards are off until `enabled` is true and the status, resolution, project, and priority lists are filled in).

The background worker runs inside the web service process, so keep one running instance. See [.skills/jira-rewards/SKILL.md](../.skills/jira-rewards/SKILL.md) for the policy SQL, formula, spend limits, and troubleshooting.

## Verification

`npm test` runs mocked API security tests using ephemeral loopback listeners, without real credentials or Supabase network calls. `npm run build` compiles the production bundle. Real-account/browser acceptance testing should cover login, reload/session restore, expiry, logout, a second account, and mobile layout.

With PostgreSQL command-line tools installed, `OFFICE_TEST_POSTGRES=1 node --test server/marketplaceDatabase.test.js` validates both migrations, reruns after purchases, authenticated account isolation, anonymous denials, private-helper restrictions, RLS, prices, ownership, and welcome credits in a disposable local cluster. It uses synthetic identities and a private Unix socket, never the live project. The temporary server is stopped and its generated files removed afterwards. The database test is opt-in and skipped during a normal `npm test`.

## Run the production build locally

```
npm run build
npm start                 # http://localhost:4173, server + API, reads .env
PORT=8080 npm start       # pick a port the way Render does
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No open ports detected on 0.0.0.0` | The start command is not serving on `$PORT` on all interfaces. Use `npm start`. Do **not** use `npm run dev` (the dev server listens on `localhost:5173` only) or `npm run build` alone (it exits) |
| `dist/ is missing` on start | The build command did not run `npm run build` |
| `/api/...` answers 503 | `SUPABASE_URL` / `SUPABASE_SECRET_KEY` are not set on the service |
| Login answers 403 | Set `APP_ORIGIN` to the exact Office Floor public origin and confirm the user's profile has an allowed role |
| `/api/...` answers 503 with keys configured | Check project/key configuration and existing profiles/calendar schema; raw provider errors are intentionally not logged |
| `vite: not found` during the build | `vite` must be in `dependencies`, not `devDependencies`, because Render installs with `NODE_ENV=production`. It is; do not move it back |
| `Blocked request. This host is not allowed` | Only with `vite preview`: `preview.allowedHosts` in `vite.config.js` must stay `true` (or list your domain). `npm start` does not use Vite |
| Build fails with a Node version error | Vite 8 needs Node `^20.19.0` or `>=22.12.0` (set in `engines` and `.node-version`). Make sure Render is not overriding it with an older `NODE_VERSION` |
| Blank page after a successful deploy | Open the browser console. Check the build output has an `assets/` folder and that `index.html` is being served from `dist` (Static Site: publish directory must be `dist`) |

## Notes

- `window.__sim` (the debug hook) is still included in production builds. See [ROADMAP.md](ROADMAP.md).
- The small login entry loads first; the ~850 KB scene chunk is loaded only after authentication succeeds.
