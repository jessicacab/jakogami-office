async function jsonRequest(url, options = {}, fetcher = fetch) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) {
    const code = response.status === 429 ? 'jira_rate_limited'
      : [401, 403].includes(response.status) ? 'jira_reconnect_required'
        : response.status === 404 ? 'jira_issue_unavailable' : 'jira_provider_unavailable';
    throw Object.assign(new Error(code), { status: response.status });
  }
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_000_000) throw new Error('jira_response_too_large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function makeJiraClient(config, fetcher = fetch) {
  const tokenRequest = body => jsonRequest('https://auth.atlassian.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, client_id: config.clientId, client_secret: config.clientSecret }),
  }, fetcher);
  const api = (cloudId, accessToken, path) => {
    if (!/^[a-f0-9-]{36}$/.test(cloudId)) throw new Error('jira_invalid_site');
    return jsonRequest(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, fetcher);
  };
  async function pages(cloudId, token, path, field) {
    const result = [];
    let expected = null;
    for (let page = 0; page < 20; page++) {
      const data = await api(cloudId, token, `${path}?startAt=${result.length}&maxResults=100`);
      if (!Array.isArray(data[field]) || !Number.isInteger(data.total)) throw new Error('jira_incomplete_data');
      if (data.startAt !== result.length || (expected !== null && expected !== data.total)) throw new Error('jira_incomplete_data');
      expected = data.total;
      result.push(...data[field]);
      if (result.length === expected) return result;
      if (!data[field].length || result.length > expected) break;
    }
    throw new Error('jira_incomplete_data');
  }
  return {
    async exchange(code) {
      return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.callback });
    },
    async refresh(refreshToken) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },
    async identity(accessToken) {
      const resources = await jsonRequest('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }, fetcher);
      const sites = resources.filter(resource => resource.url === config.site);
      if (sites.length !== 1) throw new Error('jira_invalid_site');
      const site = sites[0];
      if (!['read:jira-work', 'read:jira-user'].every(scope => site.scopes?.includes(scope))) throw new Error('jira_missing_permissions');
      const me = await api(site.id, accessToken, 'myself');
      if (!me.accountId || me.active === false) throw new Error('jira_reconnect_required');
      return { cloudId: site.id, accountId: me.accountId };
    },
    async issue(cloudId, accessToken, key) {
      if (!/^[A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15}$/.test(key)) throw new Error('invalid_jira_link');
      const fields = 'summary,description,status,priority,assignee,timetracking,timespent,resolution,resolutiondate,project,updated,issuetype';
      const issue = await api(cloudId, accessToken, `issue/${key}?fields=${fields}`);
      const worklogs = await pages(cloudId, accessToken, `issue/${key}/worklog`, 'worklogs');
      const changelog = await pages(cloudId, accessToken, `issue/${key}/changelog`, 'values');
      return { ...issue, worklogs, changelog };
    },
  };
}

export { jsonRequest, makeJiraClient };
