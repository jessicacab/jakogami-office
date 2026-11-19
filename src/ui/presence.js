import { keys } from '../camera/input.js';
import { applyRemote, clearRemote, leaveRemote } from '../people/remote.js';
import { onDuel, sendDuel } from '../persistence/duel.js';
import { ctl } from '../player/control.js';
import { player } from '../player/player.js';

/* ================= Live presence ================= */
// docs/PRESENCE-SPEC.md. While you walk around (dock → Walk), your position, facing and pose go to everyone else
// online about 10 times a second (and once a second when nothing changes, so the server knows you are still there);
// when you stop, they hear that too. Everyone else's walks come in here and go to people/remote.js.
// It rides on the duel connection (persistence/duel.js), which is only open once you are signed in.
const me = { walking: false, at: 0, sentAt: 0, last: '', active: false };
const SEND_MS = 100, HEARTBEAT_MS = 1000;
const r2 = v => Math.round(v * 100) / 100;

// What you look like you are doing right now, as a pose name others can show.
function ownAnim(p) {
  if (player.sitting) return p.task?.anim || 'listenSit';
  if (player.moving) return keys.has('shift') ? 'run' : 'walk';
  return p.task?.anim || 'stand';
}

// Per frame, from main.js.
function updatePresence(now) {
  if (!me.active) return;
  const p = player.person, walking = ctl.active && !!p && p.state === 'player';
  if (!walking) { if (me.walking) { sendDuel('presence:stop'); me.walking = false; me.last = ''; } return; }
  if (now - me.at < SEND_MS) return;
  me.at = now; me.walking = true;
  const msg = { x: r2(p.pos.x), z: r2(p.pos.z), face: Math.round(p.face * 1000) / 1000, anim: ownAnim(p), hipY: player.sitting?.hipY ?? null };
  const key = JSON.stringify(msg);
  if (key === me.last && now - me.sentAt < HEARTBEAT_MS) return;
  sendDuel('presence:move', msg);
  me.last = key; me.sentAt = now;
}

function initPresence() {
  me.active = true;
  onDuel('presence:all', list => { clearRemote(); if (Array.isArray(list)) list.forEach(applyRemote); me.last = ''; }); // (re)connected: resend yours too
  onDuel('presence:update', list => { if (Array.isArray(list)) list.forEach(applyRemote); });
  onDuel('presence:leave', ({ userId }) => leaveRemote(userId));
}
function stopPresence() { me.active = false; me.walking = false; clearRemote(); }

export { initPresence, stopPresence, updatePresence };
