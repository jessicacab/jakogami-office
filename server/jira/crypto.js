import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

function encryptTokens(tokens, secret, userId) {
  const key = hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), 'office-jira-oauth-v1', 32);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(userId));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.');
}

function decryptTokens(value, secret, userId) {
  if (typeof value !== 'string' || value.length > 32000) throw new Error('jira_reconnect_required');
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('jira_reconnect_required');
  const [iv, tag, encrypted] = parts.map(part => Buffer.from(part, 'base64url'));
  const key = hkdfSync('sha256', Buffer.from(secret, 'hex'), Buffer.alloc(0), 'office-jira-oauth-v1', 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
}

function makeWorkerStore(db, secret, now = Date.now) {
  return async (action, values = {}) => {
    const payload = JSON.stringify({ ...values, action, expiresAt: Math.floor(now() / 1000) + 120 });
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    const { data, error } = await db.rpc('office_jira_worker', { p_payload: payload, p_signature: signature });
    // Only our own fixed SQL codes (jira_sig_invalid, jira_not_bootstrapped, ...) are kept for diagnostics;
    // arbitrary provider/database text is never surfaced.
    if (error) {
      const reason = /^jira_[a-z_]{1,60}$/.test(error.message || '') ? error.message : undefined;
      throw Object.assign(new Error('jira_storage_unavailable'), { code: error.code, reason });
    }
    return data;
  };
}

export { decryptTokens, encryptTokens, makeWorkerStore };
