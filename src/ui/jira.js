import { jiraRequest } from '../persistence/jira.js';
import { $ } from './dom.js';

let cleanup = () => {};
const STATE_NAMES = { queued: 'Queued', processing: 'Analyzing', waiting: 'Waiting / reward preview', needs_review: 'Needs review', awarded: 'Coins awarded', failed: 'Check failed', cancelled: 'Cancelled', duplicate: 'Previously rewarded' };
const REASON_NAMES = {
  jira_not_assignee: 'This ticket is not assigned to your connected Jira account.',
  jira_not_user_story: 'Only User Story tickets can earn coins.',
  jira_wrong_project: 'This ticket is not in a project enabled for rewards.',
  jira_already_claimed: 'Coins for this ticket have already been claimed.',
  jira_retry_pending: 'Temporary problem checking this ticket. It will be retried automatically.',
  jira_ai_incomplete: 'The AI check did not finish. It will be retried automatically.',
  jira_ai_unavailable: 'The AI service is unavailable. It will be retried automatically.',
  jira_provider_unavailable: 'Jira or the AI service is unavailable. It will be retried automatically.',
  jira_rate_limited: 'Jira is rate limiting requests. It will be retried automatically.',
  jira_changed_during_analysis: 'The ticket changed while it was being checked. It will be rechecked.',
  jira_storage_unavailable: 'The reward database could not be reached. It will be retried automatically.',
  jira_analysis_limit: 'The AI check limit for this ticket or today was reached.',
  jira_invalid_ai_response: 'The AI answer could not be verified. An administrator needs to review this ticket.',
  jira_insufficient_evidence: 'The ticket description does not describe enough scope for an automatic reward.',
};
function node(tag, text, className) {
  const value = document.createElement(tag);
  value.textContent = text;
  if (className) value.className = className;
  return value;
}
function jobCard(job) {
  const card = node('article', '', 'jira-job'), analysis = job.analysis || {};
  const state = job.state || job.status;
  card.append(node('h3', job.issueKey || job.issue_key || 'Jira issue'), node('span', STATE_NAMES[state] || state || 'Pending', 'jira-badge'));
  if (analysis.summary) card.append(node('p', analysis.summary));
  if (analysis.assessment) {
    card.append(node('p', `Complexity: ${analysis.assessment.complexity.replaceAll('_', ' ')}`));
    card.append(node('p', analysis.assessment.explanation));
    for (const quote of analysis.assessment.evidence || []) card.append(node('blockquote', quote));
  }
  if (analysis.status) card.append(node('p', `Jira status: ${analysis.status}`));
  if (analysis.estimateSeconds != null) card.append(node('p', `Estimate: ${(analysis.estimateSeconds / 3600).toFixed(2)}h · Logged: ${(analysis.actualSeconds / 3600).toFixed(2)}h`));
  if (Number.isFinite(analysis.base)) card.append(node('p', `Base ${analysis.base} × priority ${analysis.priorityMultiplier ?? 'unmapped'} × time ${analysis.timeMultiplier ?? '—'} · Policy v${analysis.policyVersion ?? '—'}`));
  const awarded = state === 'awarded'
    ? (Number.isSafeInteger(job.amount) ? job.amount : job.rewardAmount)
    : analysis.amount;
  if (Number.isSafeInteger(awarded)) card.append(node('strong', `${awarded.toLocaleString('en-US')} coins${state === 'awarded' ? ' credited' : ' estimated — not credited'}`, 'jira-amount'));
  const reason = job.reason || (analysis.reasons || []).join(' ');
  if (reason) card.append(node('p', REASON_NAMES[reason] || reason.replaceAll('_', ' '), 'jira-reason'));
  return card;
}

function initJira(profile, {
  request = jiraRequest,
  navigate = url => window.location.assign(url),
  timers = { setInterval: (fn, delay) => window.setInterval(fn, delay), clearInterval: id => window.clearInterval(id) },
} = {}) {
  cleanup();
  if (!profile?.id) return;
  let active = true, busy = false, loading = false, timer, revision = 0, status = null;
  const seen = new Set(), listeners = [];
  const listen = (id, event, fn) => {
    const element = $(id); element.addEventListener(event, fn);
    listeners.push(() => element.removeEventListener(event, fn));
  };
  function render() {
    // Already linked: connecting again would only re-run OAuth. Disconnect first to switch Jira accounts.
    $('jiraConnect').disabled = busy || !status?.configured || !!status?.connected;
    $('jiraConnect').textContent = status?.connected ? 'Jira connected' : 'Connect Jira';
    $('jiraDisconnect').disabled = busy || !status?.connected;
    $('jiraSubmit').disabled = busy || !status?.connected || !status?.aiConfigured || !status?.policy?.enabled;
    $('jiraSetup').hidden = profile.role !== 'super_admin';
    $('jiraSetup').disabled = busy || !status?.configured;
    $('jiraRefresh').disabled = busy || loading;
    $('jiraConnection').textContent = !status?.configured ? 'Jira setup required see .skills/jira-rewards/SKILL.md.'
      : !status.aiConfigured ? 'AI analysis is not enabled/configured yet. No AI requests or rewards will run.'
        : !status.policy?.enabled ? 'The reward policy is disabled. An administrator must configure and enable it in Supabase.'
          : status.connected ? 'Jira connected. Eligible Done tickets are checked in the background.' : 'Connect your Jira account to submit your own tickets.';
    $('jiraSite').textContent = status?.site || 'No Jira site configured';
    $('jiraJobs').replaceChildren(...(status?.jobs || []).map(jobCard));
    if (!status?.jobs?.length) $('jiraJobs').append(node('p', 'No submitted tickets yet.'));
  }
  async function refresh() {
    if (!active || loading || busy) return;
    const current = revision;
    loading = true;
    try {
      const next = await request('', profile.id);
      if (!active || current !== revision) return;
      status = next;
      $('jiraError').textContent = '';
      for (const job of next.jobs || []) if ((job.state || job.status) === 'awarded' && !seen.has(job.id)) {
        seen.add(job.id); window.dispatchEvent(new Event('office-wallet-changed'));
      }
    } catch (error) { if (active && current === revision) $('jiraError').textContent = error.message; }
    finally { if (active && current === revision) { loading = false; render(); } }
  }
  async function action(path, body) {
    if (!active || busy) return;
    let succeeded = false;
    busy = true; revision++; loading = false; render(); $('jiraError').textContent = '';
    try {
      const result = await request(path, profile.id, body);
      if (!active) return;
      if (path === '/connect') {
        const url = new URL(result.url);
        if (url.origin !== 'https://auth.atlassian.com' || url.pathname !== '/authorize') throw new Error('Invalid Jira authorization URL.');
        navigate(url.href);
      }
      if (path === '/submit') { $('jiraLink').value = ''; $('jiraProgress').textContent = 'Ticket queued. You can close this panel while the server checks it.'; }
      if (path === '/setup') $('jiraProgress').textContent = 'Secure reward processing initialized. Configure the database policy before enabling rewards.';
      succeeded = true;
    } catch (error) { if (active) $('jiraError').textContent = error.message; }
    finally { if (active) { busy = false; render(); if (succeeded) await refresh(); } }
  }
  listen('jiraBtn', 'click', () => {
    if (!$('jiraDialog').open) $('jiraDialog').showModal();
    render(); refresh();
    timers.clearInterval(timer);
    timer = timers.setInterval(refresh, 10000);
  });
  listen('jiraClose', 'click', () => $('jiraDialog').close());
  listen('jiraDialog', 'close', () => { timers.clearInterval(timer); $('jiraBtn').focus(); });
  listen('jiraDialog', 'keydown', event => event.stopPropagation());
  listen('jiraForm', 'submit', event => { event.preventDefault(); if (!$('jiraSubmit').disabled) action('/submit', { link: $('jiraLink').value.trim() }); });
  listen('jiraConnect', 'click', () => action('/connect', {}));
  listen('jiraDisconnect', 'click', () => action('/disconnect', {}));
  listen('jiraSetup', 'click', () => action('/setup', {}));
  listen('jiraRefresh', 'click', refresh);
  cleanup = () => {
    active = false; revision++; timers.clearInterval(timer);
    listeners.forEach(remove => remove());
    if ($('jiraDialog').open) $('jiraDialog').close();
    $('jiraJobs').replaceChildren(); $('jiraLink').value = ''; $('jiraError').textContent = ''; $('jiraProgress').textContent = '';
    status = null; seen.clear();
  };
}

function stopJira() { cleanup(); cleanup = () => {}; }

export { initJira, jobCard, stopJira };
