# Live presence — Phase 2 (part 1)

Status: **requested 2026-11-19, implemented the same day.** See [DUEL-SPEC.md](DUEL-SPEC.md) for the duel and the open-world plan.

## What it does

Everyone online sees the coworkers who are **walking around** (dock → **Walk**) move in their own office view, live.

- While you walk, your browser sends where you are, which way you face, and what you are doing (walking, running, standing, sitting and how) about 10 times a second over the existing realtime connection (`/api/socket.io`, the same one duels use).
- Other people see your character move smoothly: your employee in the office if you are in today (it stops doing its scheduled thing while you walk), or else your character appears for as long as you walk, wearing your Marketplace gear. Clicking it shows "Walking around".
- When you stop walking, close the tab, lose the connection, or go into a duel, you are released: your employee goes back to its day (or leaves, if you are not in today), and a character that only appeared for the walk goes.

## Rules

- Only your position on the office floor and your pose are shared, and only while you walk. Nothing is stored.
- The server checks every update (signed-in session, numbers within the office floor, at most 15 a second) and forwards it to everyone else; it never sends you your own.
- A walker who goes silent for 5 seconds is treated as gone.
- Purely visual: presence changes nothing in duels, coins or records.

## Pieces

| File | Role |
|---|---|
| `server/presence.js` | Presence hub (testable, injected clock): who is walking, validation, rate limit, batched broadcasts every 100 ms, timeouts. Attached to the duel socket in `server/duel.js`. |
| `src/people/remote.js` | People walking in other browsers: takes over their office character or makes one, glides it to each update, gives it back. |
| `src/ui/presence.js` | Sends your own position while you walk; passes others' updates to `people/remote.js`. |
| `sim/step.js`, `sim/day.js`, `people/animation.js`, `ui/person.js` | A character someone is walking (state `remote`) is not moved by the simulation, keeps its place through Live's attendance refresh, is posed from the updates, and says "Walking around". |
