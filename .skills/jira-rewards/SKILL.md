---
name: jira-rewards
description: Set up, operate, and edit the policy for Jira Earn Coins rewards in Office Floor (OAuth connection, SQL migration, reward policy table, AI analysis, troubleshooting).
---

# Jira Earn Coins rewards

Users connect Jira, paste an issue link, and receive Marketplace coins after the ticket is verified Done. The browser only ever sends the link. Everything else (Jira reads, AI complexity analysis, amounts, awards) happens on the server and in SQL.

Flow: `Queued → Fetching Jira → Analyzing → Estimated reward / Awarded / Needs review`.

## What the reward is based on

Policy v1 formula, computed in SQL (`office_jira_compute_amount`), never in the browser:

```
amount = min(perIssueCap, round(baseCoins[complexity] * priorityMultipliers[priorityId] * timeMultiplier))
timeMultiplier = withinEstimateMultiplier when actual logged time <= original estimate, otherwise 1.0
```

- Complexity comes from AI (`trivial`, `small`, `moderate`, `complex`, `very_complex`) using a fixed rubric. Description length, priority, and hours are not complexity.
- Default base coins: 100 / 200 / 350 / 500 / 750. Default `withinEstimateMultiplier` 1.1, `perIssueCap` 1200, `dailyCap` 2000 per account per Manila day.
- Example: moderate, high priority (1.3), within estimate: `round(350 * 1.3 * 1.1) = 501`.
- **Eligibility gates run before any paid AI call**, each with its own message, and end as `failed` so the user can fix the ticket and resubmit:
  1. The ticket must be assigned to the user's connected Jira account (`jira_not_assignee`).
  2. The issue type must be a User Story: Jira type named `Story` or `User Story`, never a sub-task (`jira_not_user_story`).
  3. The ticket must not already be claimed. Submit refuses it immediately if any account was already paid for it, and the worker re-checks by Jira site and issue ID before spending on AI (`jira_already_claimed`).
  4. The project must be in `projectKeys` (`jira_wrong_project`).
- Insufficient evidence, missing or edited estimates, restricted or multi-author worklogs, wrong assignee, reassignment at or after completion, or a non-eligible status/resolution produce **Needs review** with no coins.
- One reward per Jira issue per site (`unique (cloud_id, issue_id)`), across all accounts. Reopened tickets do not pay a second time, and credited work is never silently deducted.

## Required setup

### 1. Apply the SQL migration

In the same Supabase project as the dashboard, run in order (SQL Editor, as the database administrator):

1. `supabase/migrations/202611090001_marketplace.sql`
2. `supabase/migrations/202611090002_marketplace_session_access.sql`
3. `supabase/migrations/202611090003_jira_rewards.sql`

The scripts are rerunnable and preserve balances, purchases, rewards, and the policy row.

### 2. Environment variables (server only, never `VITE_`)

| Variable | Purpose |
|---|---|
| `APP_ORIGIN` | Exact public origin of Office Floor |
| `JIRA_SITE_URL` | `https://your-site.atlassian.net` (root URL only, no path or port) |
| `JIRA_OAUTH_CLIENT_ID` / `JIRA_OAUTH_CLIENT_SECRET` | Atlassian OAuth 2.0 (3LO) app credentials |
| `JIRA_OAUTH_CALLBACK_URL` | `${APP_ORIGIN}/api/jira/callback` exactly; register the same URL in the Atlassian app |
| `JIRA_REWARD_SIGNING_SECRET` | 64 lowercase hex chars. Generate with `openssl rand -hex 32` |
| `JIRA_AI_ENABLED` | `true` to run analysis and the background worker |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Server-side AI analysis (no tools, `store: false`) |

Atlassian app scopes: `read:jira-work`, `read:jira-user`, `offline_access`.

### 3. Initialize the signing secret in the database

Sign in as a `super_admin` Office Floor account and call `POST /api/jira/setup` (same-origin, authenticated). This stores the signing secret in Supabase Vault through `office_jira_bootstrap`. Rotating `JIRA_REWARD_SIGNING_SECRET` and running setup again deletes all stored Jira connections and cancels pending jobs. Users must reconnect.

### 4. Edit the reward policy (administrator, SQL Editor)

There is no admin UI. The policy is one row in `public.office_jira_policy` (`id = 1`). Clients can read it; only `service_role`/SQL Editor can write. A trigger validates shape and bounds, and bumps `version` automatically when `config` changes. Rewards snapshot the policy and version they used, and a stale version is retried, never paid under old rules.

Rewards stay **off** until `enabled` is `true` and `doneStatusIds`, `allowedResolutionIds`, `projectKeys`, and `priorityMultipliers` are all non-empty.

```sql
update public.office_jira_policy
set config = jsonb_build_object(
  'enabled', true,
  'baseCoins', jsonb_build_object('trivial', 100, 'small', 200, 'moderate', 350, 'complex', 500, 'very_complex', 750),
  -- keys are Jira priority IDs (not names). Find them at <site>/rest/api/3/priority
  'priorityMultipliers', jsonb_build_object('5', 0.8, '4', 1.0, '3', 1.15, '2', 1.3, '1', 1.5),
  'withinEstimateMultiplier', 1.1,
  'perIssueCap', 1200,
  'dailyCap', 2000,
  -- status IDs in the Done category (<site>/rest/api/3/status)
  'doneStatusIds', jsonb_build_array('10001'),
  -- resolution IDs (<site>/rest/api/3/resolution)
  'allowedResolutionIds', jsonb_build_array('10000'),
  'excludedResolutionIds', jsonb_build_array('10001', '10002', '10003'),
  'projectKeys', jsonb_build_array('OPS'),
  'recheckSeconds', 300
)
where id = 1;
```

Quick edits:

```sql
-- turn rewards off immediately
update public.office_jira_policy set config = jsonb_set(config, '{enabled}', 'false') where id = 1;
-- change a single base amount
update public.office_jira_policy set config = jsonb_set(config, '{baseCoins,moderate}', '400') where id = 1;
-- inspect
select version, config, updated_at from public.office_jira_policy;
```

Bounds: coin values are integers from 0 to 100000, multipliers 0 to 10, caps and `recheckSeconds` 0 to 1000000 (the worker clamps rechecks to 30 to 86400 seconds). Unmapped priorities go to review rather than a guessed multiplier.

## Spend and abuse guards

- Link must be `https://<JIRA_SITE_URL host>/browse/PROJECT-123`. Other hosts, credentials in the URL, and extra body fields are rejected.
- 10 Jira requests per account per minute. OAuth `state` is single-use, tied to the user, and paired with an HttpOnly cookie.
- Paid AI analysis requires a reservation (`office_jira_worker_reserve_ai`): at most 5 per job, 25 per account per Manila day, 500 site-wide per day. Results are cached by input hash and model, so unchanged tickets are not re-analyzed.
- Ticket text is redacted (emails, tokens, keys) before leaving the server. AI quotes must appear verbatim in the supplied text or the result is rejected.
- Payout does a fresh Jira read after analysis and aborts if the issue, worklogs, or changelog changed during analysis.
- OAuth tokens are AES-256-GCM encrypted, bound to the user ID, and stored only in the database.
- Jobs are leased (180s) and survive restarts. The worker runs only while the server process runs (`npm start`), checks every 15 seconds, and stops on SIGTERM.

## Verification

```
npm test
OFFICE_TEST_POSTGRES=1 node --test server/jiraDatabase.test.js server/marketplaceDatabase.test.js
npm run build
```

The database test needs PostgreSQL tools (`initdb`, `psql`). It uses a disposable local cluster and never touches the live project. It covers signed worker calls, lease fencing, AI reservation limits, awards, duplicate protection, policy validation, and migration reruns.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says Jira setup is required (503 `jira_setup_required`) | Check every variable above, that the callback URL matches `APP_ORIGIN`, that the migration ran, and that `/api/jira/setup` was called by a `super_admin` |
| Connect returns to an expired/denied message | Atlassian callback URL mismatch, cookie blocked, or the 10 minute state expired |
| Job stays Queued | `JIRA_AI_ENABLED` not `true`, missing `OPENAI_*`, policy `enabled` is `false`, or the server process is not running |
| Needs review: "priority needs an administrator mapping" | Add that priority ID to `priorityMultipliers` |
| Needs review: "Done status is not enabled" | Add the status ID to `doneStatusIds` |
| Needs review: AI limit | The per-job, account, or site AI reservation cap was reached; it resets daily (Asia/Manila) |
| Everyone must reconnect | The signing secret was rotated |
