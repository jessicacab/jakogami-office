import * as THREE from 'three';
import { M } from '../../render/materials.js';
import { box, dynamic, frame } from '../helpers.js';

// The duel scoreboard: a big screen on the north wall, on the one stretch without windows (plan x 890–1030, above the
// lounge), facing into the office. Like the dining TV it hangs on its own full-height panel, so it stays up when the
// walls are lowered. It shows the top 5 duellists (ui/scoreboard.js fetches the records and calls drawScoreboard).
const X = 960, WALL_FACE = 17.4; // plan pixels: centre of the board, the inside face of the north wall
const W_PX = 768, H_PX = 432;    // the screen's canvas (16:9)
const board = { canvas: null, tex: null, rows: [], note: '' };
const PIXEL = '"Silkscreen", "Courier New", monospace', BODY = '"Rubik", "Figtree", system-ui, sans-serif';
const C = { night: '#1b1426', panel: '#221a33', cream: '#fff1dc', gold: '#f7c948', ember: '#ff8a4c', teal: '#2fb5a0', dim: '#a493b4', line: '#3a2f52' };
const MEDALS = [C.gold, '#d6dde6', '#e0a15a'];

function buildScoreboard() {
  const f = frame(X, WALL_FACE, 0); // faces south, into the office
  const panelW = 2.7, tvW = 2.4, tvH = tvW * H_PX / W_PX, yc = 1.75;
  box(f, panelW, 2.5, .04, M.booth, 0, 1.25, .02);                       // full-height panel on the wall
  box(f, panelW + .02, .04, .07, M.boothFrame, 0, 2.52, .03, false);
  box(f, tvW + .08, tvH + .08, .05, M.monitor, 0, yc, .08);              // the screen's bezel
  board.canvas = document.createElement('canvas'); board.canvas.width = W_PX; board.canvas.height = H_PX;
  board.tex = new THREE.CanvasTexture(board.canvas); board.tex.colorSpace = THREE.SRGBColorSpace; board.tex.anisotropy = 4;
  const scr = dynamic(new THREE.Mesh(new THREE.PlaneGeometry(tvW, tvH), new THREE.MeshBasicMaterial({ map: board.tex, toneMapped: false })));
  scr.position.set(0, yc, .108); f.add(scr);
  drawScoreboard([], 'Loading duel records…');
}

// rows: [{ name, wins, losses, draws }] best first (at most 5 are shown); note: a line shown when there is nothing to rank.
function drawScoreboard(rows = board.rows, note = board.note) {
  board.rows = rows; board.note = note;
  if (!board.canvas) return;
  const g = board.canvas.getContext('2d'), w = W_PX, h = H_PX;
  g.fillStyle = C.night; g.fillRect(0, 0, w, h);
  // a faint grid, like the arcade screen on the sign-in page
  g.strokeStyle = 'rgba(255,241,220,.05)'; g.lineWidth = 1;
  for (let x = 0; x <= w; x += 24) { g.beginPath(); g.moveTo(x + .5, 0); g.lineTo(x + .5, h); g.stroke(); }
  for (let y = 0; y <= h; y += 24) { g.beginPath(); g.moveTo(0, y + .5); g.lineTo(w, y + .5); g.stroke(); }
  // title
  g.textBaseline = 'middle';
  g.font = `700 34px ${PIXEL}`; g.fillStyle = C.ember; g.fillText('DUEL LEADERBOARD', 34, 50); g.fillStyle = C.gold; g.fillText('DUEL LEADERBOARD', 31, 47);
  g.font = `700 15px ${PIXEL}`; g.fillStyle = C.dim; g.textAlign = 'right'; g.fillText('TOP 5 · W–L–D', w - 32, 49); g.textAlign = 'left';
  g.fillStyle = C.ember; g.fillRect(30, 84, w - 60, 4);
  // column heads
  const cols = { rank: 44, name: 104, w: 520, l: 600, d: 680 };
  g.font = `700 14px ${PIXEL}`; g.fillStyle = C.dim;
  g.fillText('#', cols.rank, 110); g.fillText('PLAYER', cols.name, 110);
  g.textAlign = 'center'; g.fillText('W', cols.w, 110); g.fillText('L', cols.l, 110); g.fillText('D', cols.d, 110); g.textAlign = 'left';
  const top = rows.slice(0, 5);
  if (!top.length) {
    g.font = `500 24px ${BODY}`; g.fillStyle = C.cream; g.textAlign = 'center';
    g.fillText(note || 'No duels yet. Be the first on the board!', w / 2, 250); g.textAlign = 'left';
  }
  top.forEach((r, i) => {
    const y = 158 + i * 54;
    if (i % 2 === 0) { g.fillStyle = 'rgba(255,241,220,.04)'; g.fillRect(30, y - 25, w - 60, 50); }
    // rank: a medal square for the top three
    g.fillStyle = MEDALS[i] ?? C.line; g.fillRect(cols.rank - 6, y - 18, 36, 36);
    g.font = `700 22px ${PIXEL}`; g.fillStyle = i < 3 ? C.night : C.cream; g.textAlign = 'center'; g.fillText(String(i + 1), cols.rank + 12, y + 1); g.textAlign = 'left';
    g.font = `500 27px ${BODY}`; g.fillStyle = C.cream;
    let name = r.name; while (g.measureText(name).width > cols.w - cols.name - 50 && name.length > 3) name = name.slice(0, -2) + '…';
    g.fillText(name, cols.name, y + 1);
    g.font = `700 26px ${PIXEL}`; g.textAlign = 'center';
    g.fillStyle = C.teal; g.fillText(String(r.wins), cols.w, y + 1);
    g.fillStyle = C.ember; g.fillText(String(r.losses), cols.l, y + 1);
    g.fillStyle = C.dim; g.fillText(String(r.draws), cols.d, y + 1);
    g.textAlign = 'left';
  });
  g.font = `500 15px ${BODY}`; g.fillStyle = C.dim; g.fillText('Challenge a coworker from Duel in the dock. Wins, then fewest losses.', 32, h - 24);
  board.tex.needsUpdate = true;
}

export { buildScoreboard, drawScoreboard };
