async function jiraRequest(path, accountId, body) {
  const response = await fetch('/api/jira' + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Office-Account': accountId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let data;
  try { data = await response.json(); } catch (_) { throw new Error('Jira rewards are unavailable. Please retry.'); }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('office-auth-lost'));
    if (data.code === 'account_changed') window.dispatchEvent(new Event('office-account-changed'));
    throw Object.assign(new Error(data.error || 'Jira rewards are unavailable.'), { code: data.code, status: response.status });
  }
  return data;
}

export { jiraRequest };
