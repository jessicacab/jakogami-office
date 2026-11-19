import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// The existing office-data client. Its privileges depend on the configured key;
// it must only ever exist here, never in browser code. Returns null when Supabase is not configured,
// and the API answers 503 instead of crashing (so the app still runs locally without credentials).
function makeSupabase(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
}

function makeSessionSupabase(env, accessToken) {
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_SECRET_KEY;
  if (!env.SUPABASE_URL || !key || !accessToken) return null;
  return createClient(env.SUPABASE_URL, key, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { transport: WebSocket },
  });
}

export { makeSessionSupabase, makeSupabase };
