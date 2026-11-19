import { analysisInput, analyzeIssue, evaluateIssue, isUserStory, redact } from './analysis.js';
import { decryptTokens, encryptTokens } from './crypto.js';

const INELIGIBLE = ['jira_wrong_project', 'jira_not_assignee', 'jira_not_user_story', 'jira_already_claimed'];

function makeUserLock() {
  const locks = new Map();
  return async (userId, fn) => {
    const previous = locks.get(userId) || Promise.resolve();
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => waiting);
    locks.set(userId, tail);
    await previous.catch(() => {});
    try { return await fn(); }
    finally { release(); if (locks.get(userId) === tail) locks.delete(userId); }
  };
}

function normalizeTokens(raw, previous = {}, now = Date.now()) {
  if (!raw?.access_token || !(raw.refresh_token || previous.refresh_token)
    || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0) throw new Error('jira_reconnect_required');
  return { access_token: raw.access_token, refresh_token: raw.refresh_token || previous.refresh_token, expiresAt: now + raw.expires_in * 1000 };
}

function makeJiraWorker({ config, store, jira, analyze = analyzeIssue, lock = makeUserLock(), timers = { setTimeout, clearTimeout } }) {
  let timer, running = false, busy = false, warned = false, stopped = false;
  async function runOnce() {
    if (busy || stopped || !config.ready || !config.aiReady) return;
    busy = true;
    let job;
    try {
      const policy = await store('policy');
      if (!policy.config.enabled) return;
      job = await store('claim');
      if (!job) return;
      await lock(job.userId, async () => {
        // Re-read under the same user lock as OAuth callbacks; never restore a stale connection.
        const connection = await store('connection', { userId: job.userId });
        if (!connection || connection.cloudId !== job.cloudId || connection.accountId !== job.accountId) throw new Error('jira_reconnect_required');
        let tokens = decryptTokens(connection.encryptedTokens, config.signingSecret, job.userId);
        if (!tokens.access_token || !Number.isFinite(tokens.expiresAt)) throw new Error('jira_reconnect_required');
        if (tokens.expiresAt <= Date.now() + 60000) {
          tokens = normalizeTokens(await jira.refresh(tokens.refresh_token), tokens);
          await store('save_tokens', { userId: job.userId, encryptedTokens: encryptTokens(tokens, config.signingSecret, job.userId) });
        }
        const issue = await jira.issue(job.cloudId, tokens.access_token, job.issueKey);
        if (!issue.id || issue.key !== job.issueKey) throw new Error('jira_issue_unavailable');
        // Eligibility gates run before any paid AI call. Each has its own reason shown to the user.
        if (!policy.config.projectKeys.includes(issue.fields?.project?.key)) throw new Error('jira_wrong_project');
        if (issue.fields?.assignee?.accountId !== job.accountId) throw new Error('jira_not_assignee');
        if (!isUserStory(issue)) throw new Error('jira_not_user_story');
        const claimed = await store('issue_claimed', { jobId: job.id, leaseToken: job.leaseToken, cloudId: job.cloudId, issueId: issue.id });
        if (claimed?.claimed === true) throw new Error('jira_already_claimed');
        const input = analysisInput(issue);
        if (job.analysis?.inputHash !== input.inputHash || job.analysis?.model !== config.model || !job.analysis?.assessment) {
          const budget = await store('reserve_ai', { jobId: job.id, leaseToken: job.leaseToken });
          if (budget?.allowed !== true) throw new Error('jira_analysis_limit');
        }
        const analysis = await analyze(config, issue, job.analysis);
        let evaluation = evaluateIssue(issue, job.accountId, policy.config, analysis.assessment);
        let latestIssue = issue;
        if (stopped) throw new Error('jira_retry_pending');
        if (evaluation.eligible) {
          // Payout uses a fresh Jira read after AI latency, not the old displayed status.
          latestIssue = await jira.issue(job.cloudId, tokens.access_token, job.issueKey);
          if (latestIssue.id !== issue.id || latestIssue.key !== job.issueKey
            || latestIssue.fields?.updated !== issue.fields?.updated
            || JSON.stringify(latestIssue.worklogs) !== JSON.stringify(issue.worklogs)
            || JSON.stringify(latestIssue.changelog) !== JSON.stringify(issue.changelog)) throw new Error('jira_changed_during_analysis');
          evaluation = evaluateIssue(latestIssue, job.accountId, policy.config, analysis.assessment);
        }
        const details = {
          ...analysis, ...evaluation, policyVersion: policy.version, policySnapshot: policy.config,
          summary: redact(latestIssue.fields?.summary).slice(0, 256), issueId: latestIssue.id,
        };
        if (evaluation.eligible) {
          await store('award', {
            jobId: job.id, leaseToken: job.leaseToken, issueId: issue.id, cloudId: job.cloudId,
            analysis: details, policyVersion: policy.version, complexity: analysis.assessment.complexity,
            priorityId: evaluation.priorityId, withinEstimate: evaluation.withinEstimate,
            eligible: true, completed: true, statusId: evaluation.statusId, resolutionId: evaluation.resolutionId,
          });
        } else {
          await store('finish', {
            jobId: job.id, leaseToken: job.leaseToken,
            state: evaluation.reasons.length && evaluation.completed ? 'needs_review' : 'waiting',
            analysis: details, reason: evaluation.reasons.join(' ') || 'Waiting for an eligible Done status.',
          });
        }
      });
      warned = false;
    } catch (error) {
      if (job) {
        const reason = [
          'jira_reconnect_required', 'jira_issue_unavailable', 'jira_incomplete_data', 'jira_response_too_large',
          ...INELIGIBLE, 'jira_invalid_ai_response', 'jira_insufficient_evidence', 'jira_analysis_limit',
        ].includes(error.message) ? error.message : 'jira_retry_pending';
        // Retryable failures still show which step failed (our own fixed codes only, never provider text).
        const detail = reason === 'jira_retry_pending' && /^jira_[a-z_]{1,60}$/.test(error.reason || error.message || '') ? (error.reason || error.message) : reason;
        // Ineligible tickets end as "failed" so the user can fix the ticket and submit it again;
        // "needs_review" jobs block resubmission.
        const state = reason === 'jira_retry_pending' ? 'waiting' : INELIGIBLE.includes(reason) ? 'failed' : 'needs_review';
        try {
          await store('finish', { jobId: job.id, leaseToken: job.leaseToken, state, analysis: job.analysis || {}, reason: detail });
        } catch (_) { /* Lease expiry makes interrupted work retryable; never log payloads/tokens. */ }
      }
      if (!warned) { console.warn('[jira] Background check paused or retrying:', /^jira_[a-z_]{1,60}$/.test(error?.message || '') ? error.message : 'unexpected_error', error?.reason || error?.status || ''); warned = true; }
    } finally { busy = false; }
  }
  async function tick() {
    if (!running) return;
    await runOnce();
    if (running) { timer = timers.setTimeout(tick, 15000); timer?.unref?.(); }
  }
  return {
    runOnce,
    start() { if (!running && config.ready && config.aiReady) { stopped = false; running = true; timer = timers.setTimeout(tick, 1000); timer?.unref?.(); } },
    stop() { stopped = true; running = false; timers.clearTimeout(timer); },
  };
}

export { makeJiraWorker, makeUserLock, normalizeTokens };
