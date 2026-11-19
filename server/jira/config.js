function jiraConfig(env) {
  let site, callback;
  try {
    site = new URL(env.JIRA_SITE_URL);
    callback = new URL(env.JIRA_OAUTH_CALLBACK_URL);
  } catch (_) {}
  const origin = env.APP_ORIGIN || 'http://localhost:5173';
  const ready = !!site && site.protocol === 'https:' && /^[a-z0-9-]+\.atlassian\.net$/.test(site.hostname)
    && site.pathname === '/' && !site.username && !site.password && !site.port && !site.search && !site.hash
    && !!callback && callback.origin === origin && callback.pathname === '/api/jira/callback'
    && !callback.search && !callback.hash && !callback.username && !callback.password
    && !!env.JIRA_OAUTH_CLIENT_ID && !!env.JIRA_OAUTH_CLIENT_SECRET
    && /^[a-f0-9]{64}$/.test(env.JIRA_REWARD_SIGNING_SECRET || '');
  return {
    ready, origin, site: site?.origin, callback: callback?.href,
    clientId: env.JIRA_OAUTH_CLIENT_ID, clientSecret: env.JIRA_OAUTH_CLIENT_SECRET,
    signingSecret: env.JIRA_REWARD_SIGNING_SECRET,
    aiReady: env.JIRA_AI_ENABLED === 'true' && !!env.OPENAI_API_KEY && !!env.OPENAI_MODEL,
    aiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL,
  };
}

function issueKeyFromLink(link, site) {
  if (typeof link !== 'string' || link.length > 2048) throw new Error('invalid_jira_link');
  let url;
  try { url = new URL(link); } catch (_) { throw new Error('invalid_jira_link'); }
  const match = /^\/browse\/([A-Z][A-Z0-9_]{0,31}-[1-9][0-9]{0,15})\/?$/.exec(url.pathname);
  if (!match || url.origin !== site || url.username || url.password) throw new Error('invalid_jira_link');
  return match[1];
}

export { issueKeyFromLink, jiraConfig };
