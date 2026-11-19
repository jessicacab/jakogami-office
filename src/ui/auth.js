import { $ } from './dom.js';

async function authRequest(path, body) {
  const res = await fetch('/api/auth/' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = res.status === 204 ? {} : await res.json();
  if (!res.ok) {
    const error = new Error(data.error || 'Sign-in is temporarily unavailable.');
    error.status = res.status;
    throw error;
  }
  return data;
}

function initAuth({
  request = authRequest,
  loadOffice = () => import('../main.js'),
  reload = () => location.reload(),
  timers = {
    setInterval: (callback, delay) => window.setInterval(callback, delay),
    clearInterval: id => window.clearInterval(id),
  },
} = {}) {
  let office = null, loaded = false, generation = 0, sessionTimer;
  const gate = $('authGate'), app = $('officeApp'), form = $('loginForm');

  function showLogin(message = '') {
    generation++;
    timers.clearInterval(sessionTimer);
    app.hidden = true; app.inert = true;
    office?.stopOffice();
    gate.hidden = false; form.hidden = false;
    $('authStatus').textContent = '';
    $('loginError').textContent = message;
    $('loginPassword').value = '';
    $('loginPassword').type = 'password';
    $('passwordToggle').textContent = 'Show';
    $('passwordToggle').setAttribute('aria-pressed', 'false');
    $('retryLogout').hidden = true;
    $('loginSubmit').disabled = false;
    $('loginSubmit').textContent = 'Press start';
    $('accountName').textContent = '';
    $('loginEmail').focus();
  }

  async function enter(profile) {
    // Scene modules own long-lived listeners. A new account gets a fresh document, never a second bootstrap.
    if (loaded) { reload(); return; }
    loaded = true;
    const current = ++generation;
    $('accountName').textContent = profile.full_name || 'Signed in';
    $('authStatus').textContent = 'Opening your office…';
    form.hidden = true;
    try {
      office = await loadOffice();
      if (current !== generation) { office.stopOffice(); return; }
      await office.initOffice(() => current === generation, profile);
      if (current !== generation) { office.stopOffice(); return; }
      gate.hidden = true; app.hidden = false; app.inert = false;
      sessionTimer = timers.setInterval(async () => {
        try {
          const verified = await request('session');
          if (verified.profile.id !== profile.id) {
            showLogin('The signed-in account changed in another tab. Reloading…');
            reload();
          }
        }
        catch (_) { showLogin('Your session could not be verified. Please sign in again.'); }
      }, 60000);
    } catch (_) {
      showLogin('The office could not load. Check your connection and sign in to retry.');
    }
  }

  $('passwordToggle').addEventListener('click', () => {
    const visible = $('loginPassword').type === 'password';
    $('loginPassword').type = visible ? 'text' : 'password';
    $('passwordToggle').textContent = visible ? 'Hide' : 'Show';
    $('passwordToggle').setAttribute('aria-pressed', String(visible));
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    $('loginSubmit').disabled = true; $('loginSubmit').textContent = 'Loading…';
    $('loginError').textContent = '';
    try {
      const { profile } = await request('login', { email: $('loginEmail').value, password: $('loginPassword').value });
      $('loginPassword').value = '';
      await enter(profile);
    } catch (error) { showLogin(error.message); }
  });
  async function signOut() {
    // Hide account data immediately, even if the network is unavailable.
    showLogin('Signing out…');
    form.hidden = true;
    $('retryLogout').hidden = true;
    try { await request('logout', {}); showLogin(); }
    catch (_) {
      showLogin('Sign out could not be confirmed. Retry before leaving this device.');
      $('retryLogout').hidden = false;
    }
  }
  $('signOut').addEventListener('click', signOut);
  $('retryLogout').addEventListener('click', signOut);
  window.addEventListener('office-auth-lost', () => showLogin('Your session has ended. Please sign in again.'));
  window.addEventListener('office-account-changed', () => {
    showLogin('The signed-in account changed in another tab. Reloading…');
    reload();
  });
  request('session').then(({ profile }) => enter(profile)).catch(error => showLogin(error.status === 401 ? '' : error.message));
}

export { initAuth };
