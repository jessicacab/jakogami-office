# Duel and free roam — Phase 1 specification

Status: **Approved 2026-11-18 and implemented (Phase 1).** All five recommendations in [Decisions to approve](#decisions-to-approve) were accepted. Where the build differs from the first draft, this page has been updated; see [Changes during implementation](#changes-during-implementation).

## 1. Summary

Office Floor becomes a small open world in the office itself. Phase 1 delivers:

1. **Free roam:** walk around the office as **your own employee character**, wearing your equipped gear.
2. **Duel:** a real-time, server-refereed 1v1 fight between two signed-in coworkers who **both agreed to it**. Gear attributes (STR, AGI, INT) shape the fight, but skill decides it.

Coins earned from Jira buy gear, gear makes your duelist different, and duels are something to do while walking around the office.

### Goals

- Give equipped gear a real gameplay effect.
- Reuse what exists: the player controller and first/third-person cameras, the Power Slap referee pattern (`server/slap.js`, `sim/slap.js`), attributes (`config/marketplace.js`), equipment rendering.
- Keep combat strictly consensual and server-authoritative.

### Non-goals (Phase 1)

- Seeing other players walk around live (shared presence) → Phase 2.
- Missions/jobs board → Phase 2. Office mischief and the "heat" meter → Phase 3.
- Coin wagers or coin rewards for duels.
- Re-enabling office chat or Power Slap.
- Hurting non-player characters. NPCs are real coworkers; they cannot be attacked, ever.

## 2. Ground rules

| Rule | How it is enforced |
|---|---|
| Nobody fights without saying yes | Every duel needs an explicit **Accept** from the challenged person in their own browser. A challenge expires after 20 s. |
| Only real, signed-in staff | The duel socket authenticates with the existing Office Floor session cookie; identity is `profiles.id`, never a client-supplied name or key. |
| No harassment loops | One open challenge per person; 5 s between challenges; after a decline or expiry the same challenger cannot challenge the same person again for 5 minutes. A **Not available** switch hides you from challenges entirely. |
| Offline people are untouchable | You can only challenge someone who is online and available. Their in-office NPC alone is not challengeable. |
| Stats cannot be faked | The server reads both fighters' equipment from Supabase at match start and computes attributes itself. |
| No gambling | No coins move because of a duel in Phase 1. |

## 3. Player experience

### 3.1 Free roam

- The dock gets a **Walk** button (and `W`-style hint in Help). It starts **third person**; `V` toggles first person; `Esc` exits. These camera modes already exist (`camera/modes/firstPerson.js`, `thirdPerson.js`); they are re-registered and their HUD bar markup restored.
- You walk as **yourself**:
  - If you are in the office today (your NPC is in the scene), you take control of that NPC (`takeControl`). When you stop walking, they get on with their day.
  - Otherwise your character spawns at the entrance with your saved look (`character_information`) and your equipped gear, and is removed when you stop walking. Shopping and walking never add you to the attendance list.
- The old local "You" character (look in `localStorage`) is no longer used for walking. The Character lab button inside the walk bar is removed; looks are edited where they are today.
- Walking is **local** in Phase 1: other people do not see you move until Phase 2.

### 3.2 Finding an opponent

Three ways to challenge, all of which send the same challenge:

1. **Walking:** look at a coworker's character. If they are online and available, the prompt shows **G — Challenge … to a duel** (`F` is already fullscreen).
2. **Employee card:** a **Challenge to a duel** button, enabled only when that person is online and available.
3. **Duel panel** (the dock's **Duel** button, no longer "Coming soon"): lists who is online with their STR/AGI/INT and duel record (W–L–D), each with **Challenge**. It also holds your **Available for duels** switch.

People who are online show a small crossed-swords marker above their character (available) or a dimmed one (busy or unavailable).

### 3.3 Accepting

The challenged person sees a card with the challenger's name, attributes and record, and **Accept** / **Decline** buttons with a 20 s countdown. Nothing happens unless they press Accept. If they have the app open in several tabs, the card appears in all of them; the tab that accepts is the one that fights.

### 3.4 The fight

- **Arena:** both fighters walk to a free duel ring (12 s to get there, then they are placed). The three rings are painted on the floor; they are found at startup on open floor nearest the kitchen and the lounge, away from every seat and spot, so every browser finds the same three. Fighters who are not in the office today appear at the arena for the fight and leave afterwards. Everyone online sees the duel happen in their own office view and on a fight card at the top of the screen.
- **Fighters stay planted** facing each other (no movement during the fight). That keeps the netcode simple and fair: only actions are sent, not positions.
- **Controls:**

| Action | Mouse/keyboard | Touch | What it does |
|---|---|---|---|
| Strike | Left click or `J` | Strike button | 0.4 s visible wind-up, then hits. Cooldown depends on AGI. |
| Guard | Hold right click, `K` or `Shift` | Hold Guard | Incoming strikes deal 30%. Cannot strike while guarding. |
| Parry | Start guarding ≤ 0.25 s before a strike lands | same | Strike deals 0 and the attacker is staggered for 1 s. |
| Focus Blast | `Q` or `L` | Blast button | Costs 50 mana, 0.6 s wind-up, cannot be guarded, 6 s cooldown. Damage depends on INT. |

- **Win:** reduce the opponent to 0 HP (**KO**). After **90 s**, the higher remaining HP percentage wins (**time**); within 2 points of each other is a **draw**. Disconnecting for more than 10 s is a **forfeit**.
- **HUD:** both fighters' HP and mana bars, your cooldowns, the opponent's wind-up as a warning flash, and the timer. The walk HUD hides during the fight.
- **After:** a result card (winner, how, damage dealt). Both characters return to what they were doing. The result is saved to both records.

## 4. Combat rules

All rules live in one plain-data module, `src/config/duel.js`, shared by the server referee and the browser HUD (same pattern as `config/slap.js`). Attributes are the existing totals from `characterAttributes()`: base 10 each, plus equipped gear.

| Stat | Formula (tuned, `PER_POINT` in `config/duel.js`) | Base 10/10/10 | Best current gear |
|---|---|---|---|
| Max HP | `140 × (1 + 0.005 × (STR − 10))` | 140 | 148 (STR 22) |
| Strike damage | `12 × (1 + 0.0065 × (STR − 10))`, ±15% random | 12 | 12.9 |
| Strike cooldown | `1.2 s × (1 − 0.007 × (AGI − 10))`, min 0.9 s | 1.20 s | 1.12 s (AGI 19) |
| Dodge chance (strikes only) | `0.05 + 0.005 × (AGI − 10)`, max 0.15 | 5% | 9.5% |
| Critical chance (×1.5) | `0.05 + 0.0015 × (INT − 10)`, max 0.15 | 5% | 7.3% (INT 25) |
| Mana | max 100, start 50, regen `6/s × (1 + 0.003 × (INT − 10))` | 6.0/s | 6.3/s |
| Focus Blast damage | `20 × (1 + 0.003 × (INT − 10))` | 20 | 20.9 |

**Balance target.** Gear should matter but not decide the fight. Between two players of equal skill, the fully geared one should win about **65–70%** of the time. A clearly better player (one who parries well) should usually beat a better-geared player. The first-draft coefficients failed this badly (the INT set won 85–94% against base gear), so they were tuned with the bot simulation (`server/duelBots.js`, `server/duelBalance.test.js`). Retuned again for the arena (movement, reach and dodgeable blasts, Phase 1.1). Results (1,500 seeded duels each, average-skill bots that move): full STR set vs base 66%, AGI set 65%, INT set 68%; a skilled player in base gear beats an average geared player 58–66%; the three sets against each other 48–54%. The INT set's slight edge comes from its armor's STR, and it is also the most expensive set. Rerun `npm test` after any catalog or rule change.

The STR-heavy build (tank), the AGI build (fast and evasive) and the INT build (blasts and crits) should each be a viable choice. The bot simulation also checks that no single build wins more than 60% against the other two.

## 5. Architecture

### 5.1 Server: `server/duel.js` (new)

- A Socket.IO server attached to the same HTTP server as the app at path **`/api/socket.io`**. The path must be under `/api` because the session cookies are scoped to `Path=/api`.
- Attached in production (`server/index.js`) and in the Vite dev/preview servers (`vite.config.js`, on `server.httpServer`), mirroring how the API is mounted.
- **Handshake authentication:** a Socket.IO middleware rejects the connection unless the `Origin` matches the same allow-list as `originGuard`, **and** the `officeAccess` cookie verifies with Supabase (`auth.getUser`), **and** the profile has role `employee` or `super_admin`. `makeAuth` gains a `verifySocket(headers)` function that reuses `profile()`. The browser calls `GET /api/auth/session` immediately before connecting so an expired access cookie is refreshed first. A rejected handshake makes the client refresh once and retry, then shows "Sign in again".
- **Referee:** in-memory, like `server/slap.js`. It tracks who is online (user id → sockets), availability, open challenges, cooldowns between pairs, and matches. Fights run on a **20 Hz** server tick. Clients send only intents (`strike`, `guardOn`, `guardOff`, `blast`). The server applies cooldowns, wind-ups, guard and parry windows by **server receive time**, rolls dodge, crit and damage, and broadcasts results. A client cannot report damage, HP or stats.
- **Stats:** at match start the server reads both users' rows from `office_market_equipment` with the server-only client and computes `characterAttributes()` and `duelStats()`. These are frozen for the match, so swapping gear mid-fight does nothing.
- **Arena capacity:** three concurrent duels, one per duel ring (see [Decisions to approve](#decisions-to-approve)). When all spots are busy, a challenge is refused with "All duel rings are taken, try again in a bit".
- **Limits:** connection message size 4 KB, an input rate cap (20 intents/s per socket, extras dropped), at most 50 open challenges overall.
- **Single instance:** like login throttling and refresh coalescing, duel state is process-local. Keep one Render instance or sticky routing. Restarting the server ends running duels with no result saved.

### 5.2 Persistence: Supabase migration `supabase/migrations/202611180001_duel.sql` (new)

- Table `office_duel_matches`: `id uuid pk`, `challenger uuid → auth.users`, `opponent uuid → auth.users`, `winner uuid null`, `result text check in ('ko','time','forfeit','draw')`, `challenger_attributes jsonb`, `opponent_attributes jsonb`, `started_at`, `ended_at timestamptz`. Indexed on each user column.
- RLS enabled; no direct table access for `authenticated` or `anon`. Only the server (secret key) inserts, once per finished match.
- Function `office_duel_records(user_ids uuid[])` (security definer, `authenticated` only, rejects callers without an allowed profile) returns `user_id, wins, losses, draws`. Records are visible to every signed-in office user. Match history details are not exposed in Phase 1.
- A new API route `GET /api/duel/records?ids=…` (session-protected, at most 100 ids) calls it with the per-request session client, like Marketplace.

### 5.3 Browser

| File | Layer | Responsibility |
|---|---|---|
| `src/config/duel.js` (new) | config | Rules, timings, limits, `duelStats(attributes)`. Plain data, no Three.js or DOM. |
| `src/persistence/duel.js` (new) | persistence | The `socket.io-client` connection (session check first, reconnect), `fetchDuelRecords(ids)`. |
| `src/sim/duel.js` (new) | sim | State `duel = { matches }`: fighters, spots, phase, HP/mana mirrors from the server, bringing absent fighters to the arena and back. Modelled on `sim/slap.js`; imports no `ui/`. |
| `src/ui/duel.js` (new) | ui | Duel panel, challenge and accept cards, fight HUD and input, result card, overhead markers, availability switch. |
| `src/people/animation.js` | people | New poses: `duelReady`, `duelStrike`, `duelGuard`, `duelBlast`, `duelHit`, `duelStagger`, `duelKo`, `duelWin`. |
| `src/render/duelFx.js` (new) | render | Focus Blast orb and hit flashes. Per-frame code reuses scratch objects. |
| `src/player/player.js`, `control.js` | player | `walkAsSelf(profile)`: take control of your NPC or spawn your own character with your look and gear; the walk bar no longer offers the Character lab. |
| `src/camera/controller.js` | camera | Re-register `fpMode` / `thirdPersonMode`. |
| `src/world/furniture/duelRing.js` (new) | world | Paints a ring and registers its two `'duel'` spots (`mkSpot`); `sim/duel.js` chooses the places from the nav grid. |
| `server/duelEngine.js` (new) | server | The pure fight rules: intents in, events out, injected clock and random numbers. |
| `server/duelBots.js` (new) | server (tests) | Bot fighters for the balance simulation. |
| `server/routes/duel.js` (new) | server | `GET /api/duel/records`. |
| `src/ui/person.js` | ui | **Challenge to a duel** button, duel record line, duel status text ("Dueling Ana at the kitchen table"). |
| `index.html`, `src/styles/duel.css` (new) | ui | Duel dialog, cards, HUD, walk bar and touch stick markup; Walk dock button; Duel button enabled. Everything shown while walking is also covered by the `body.fp` / `body.tp` rules. |
| `src/bootstrap.js` | — | `initDuel(profile)` after `initMarketplace`. |

Power Slap code stays as it is and stays disabled. The duel spots use their own kind, `'duel'`, so the two never compete for a spot.

### 5.4 Socket events

Client → server (each with an ack `{ ok, error? }`):

| Event | Payload | Notes |
|---|---|---|
| `duel:available` | `{ on: boolean }` | Default on at connect unless this browser saved "off". |
| `duel:challenge` | `{ to: userId }` | Validated against online, available, not busy, cooldowns, arena capacity. |
| `duel:answer` | `{ id, accept: boolean }` | Only from the challenged user; the answering socket becomes their fighting socket. |
| `duel:cancel` | `{ id }` | Challenger withdraws. |
| `duel:input` | `{ id, act: 'strike' \| 'guardOn' \| 'guardOff' \| 'blast' }` | Only from the fighting socket; rate-limited. |

Server → client:

| Event | Payload |
|---|---|
| `duel:online` | `[{ userId, name, available, busy, attributes }]` |
| `duel:invite` / `duel:invite-closed` / `duel:declined` | challenge lifecycle, with the reason (`declined`, `expired`, `offline`, `cancelled`) |
| `duel:start` | `{ id, a, b, spot, stats: [a, b], endsAt }` |
| `duel:event` | `{ id, t, who, kind: 'windup' \| 'hit' \| 'dodge' \| 'guarded' \| 'parry' \| 'stagger' \| 'blast', dmg?, crit? }` |
| `duel:state` | `{ id, hp: [a, b], mana: [a, b], guard: [a, b] }` at 10 Hz |
| `duel:end` | `{ id, winner: userId \| null, result }` |

## 6. UI copy

- Dock: **Walk**, **Duel** (badge shows open challenges).
- Challenge sent: "Challenge sent to Ana. Waiting for an answer…" (first names only; UI copy never uses pronouns for people)
- Invite: "**Marco** challenges you to a duel. STR 18 · AGI 14 · INT 11 · 4–2–0" **Accept** / **Decline**
- Refusals: "Ana is busy right now", "Ana isn't taking duels right now", "You can challenge Ana again in 4 min", "All duel rings are taken, try again in a bit".
- Result: "**KO!** Marco wins" / "Time! Ana wins on health" / "Draw" / "Ana left the duel — Marco wins".

## 7. Errors and edge cases

| Case | Behaviour |
|---|---|
| Session expires mid-fight | The connection stays authenticated until it drops. On reconnect the client re-verifies; within the 10 s grace the fight resumes, otherwise it is a forfeit. |
| Same user, two tabs | Both show invites and the fight. Only the accepting/challenging tab sends inputs; others spectate. |
| Fighter's NPC is mid-meeting or seated | The duel takes priority, like online Power Slap; they stand up and go to the arena. |
| Supabase unavailable at match start | The challenge fails with "Duels are unavailable right now"; no match without verified stats. |
| Migration not applied | The Duel panel shows a setup-required message (like Marketplace); fights still run but records are not saved and the server logs one warning. |
| Live / Simulate clock | Duels work in both; the arena and NPC pathing do not depend on the clock. |
| Lights off / night | Fight still visible; the HUD carries the information. |

## 8. Testing and acceptance

Automated (`npm test`, added to the `test` script):

- `server/duelEngine.test.js`: formulas at base and maximum gear, caps, wind-up, guard, parry (and no parry from mashing or a late guard), dodge, crit, blast, KO order, time, draw, forfeit.
- `server/duelBalance.test.js`: the **bot balance simulation** (1,500 seeded duels per pairing) asserting the targets in section 4.
- `server/duel.test.js` with a fake clock and seeded random: handshake rejects a missing or invalid cookie, a wrong origin and a disallowed role; challenge validations and cooldowns; a challenge is never started without accept; only the fighting socket's inputs count; wind-up, guard, parry and dodge timing; KO, time, draw, forfeit; stats come from the database and not the client; one result row per match.
- `server/duelSchema.test.js` (static) and `server/duelDatabase.test.js` + `supabase/tests/duel_records.sql` (a disposable real PostgreSQL, opt-in with `OFFICE_TEST_POSTGRES=1`; on macOS also set `LC_ALL=en_US.UTF-8`): RLS on, no browser grants, constraint checks, correct totals, `office_duel_records` rejects non-office and anonymous callers.

Manual acceptance in two browsers with two real accounts (plus the checklist in [CODING-STANDARDS.md](CODING-STANDARDS.md#before-you-push)):

1. Walk starts in third person as yourself with your gear; `V`, `Esc` work; others' views are unchanged.
2. Challenge from all three entry points; decline, expiry, cooldown message, and the availability switch all behave as in section 2.
3. A full fight with each result (KO, time, draw, forfeit by closing the tab); a third browser sees the fight as a spectator.
4. Equip different gear and confirm the HUD stats and damage numbers change on the next fight.
5. Records update on both employee cards.
6. Phone-width touch controls work.

Docs updated with the feature: README (controls and Duel), ARCHITECTURE (new state, server socket, folders), DEPLOYMENT (migration, single-instance note), ROADMAP (Phases 2–3).

## 9. What comes next

- **Phase 2:** shared presence (see coworkers who are walking around, live, over the same socket), then a **jobs board** of short office missions with capped coin rewards.
- **Phase 3:** opt-in office mischief (pranks only on people who opted in) and a "heat" meter where the boss notices.

## Decisions to approve

| # | Decision | Recommendation |
|---|---|---|
| 1 | **Arena size.** The live office has one duel-capable spot pair (the kitchen table ends), so only one duel at a time. | Add **two more duel spot pairs** in open floor areas, so up to **3 duels at once**. |
| 2 | **Coin rewards** for winning. | **None in Phase 1** (records only). Revisit with capped daily rewards once balance is proven. |
| 3 | **Availability default** when you come online. | **Available**, since each duel still needs an explicit Accept. Your "Not available" choice is remembered in this browser. |
| 4 | **Real-time** action combat (this spec) versus turn-based like Power Slap. | **Real-time with planted fighters**: it feels like an action game without the cost of position netcode. |
| 5 | **Records visibility.** | **W–L–D visible to all signed-in staff**; no public match history or leaderboard in Phase 1. |

## Changes during implementation

- **Challenge key:** `G`, not `F` (`F` toggles fullscreen).
- **Rings:** three rings on open floor, found from the nav grid at startup (the kitchen table ends were too far apart for a stand-up fight). Each shows as a painted circle.
- **Numbers:** retuned with the bot simulation (section 4).
- **Who fights in the scene:** your own duel always uses you (your employee taken over, or your own character), and the view switches to third person. A coworker who is in the office fights as their character; one who is not in today appears at the ring for the duel and leaves afterwards. Live mode's once-a-minute attendance refresh leaves people who are in a duel, or who you are walking as, where they are.
- **Timing:** the HUD clock and the post-fight result follow real time (the server's deadline), not frame time, so a slow computer shows the same clock as everyone else.
- **Your side:** your own HUD always puts you on the left.
- **Cooldown hint:** after someone declines or lets a challenge expire, their row says "Again in N min" instead of offering Challenge.

## Verified

- `npm test`: 139 pass, 3 skipped (the opt-in PostgreSQL tests, which pass separately against PostgreSQL 18).
- `npm run build` succeeds.
- End to end in headless Chromium, with the real BFF and duel socket over a fake Supabase and synthetic accounts: three signed-in browsers; the panel, availability switch, invite, decline and cooldown; a full duel to KO seen by both fighters and a spectator with matching clocks; one result row saved and records updated; an in-office fighter walking to the ring and returning to work, surviving the attendance refresh; `G` while walking; phone width without horizontal scroll; no console errors.
- **Not yet verified:** real accounts on the real Supabase project, and the migration in that project. Do the [Duel setup](DEPLOYMENT.md#duel-setup) check before launch.

## Phase 1.1: the rooftop arena (approved 2026-11-18)

Decisions: duels leave the office for a separate arena, **the office rooftop at dusk**; fighters **move freely**; **anyone online can watch**.

- **Leaving the office.** When a duel starts, both fighters vanish from the office in a flash (status "In a duel") and reappear where they were when it ends. The painted rings on the office floor are removed. Duels are no longer limited by floor space; the server allows up to 6 at once.
- **The arena.** A separate 3D scene: the building's rooftop helipad at sunset, a city skyline with lit windows, rooftop equipment and lamps. Built the first time someone enters it, never in the office scene.
- **Intro.** A 4-second fly-in with a "3, 2, 1, Fight!" countdown replaces the 12-second walk.
- **Movement.** WASD (or a touch stick) moves you, locked on to your opponent: W closes in, S backs off, A/D circle. Guarding slows you to 50%, winding up to 40%, a parry stagger to 30%. Fighters stay on the helipad (6.5 m radius) and cannot overlap.
- **Range.** A strike only lands within 1.8 m when it connects; otherwise it is a **miss**, so backing out of range is a defence. Focus Blast is now a projectile aimed where the opponent stood when it was released (9 m/s); stepping more than 0.9 m away from that point makes it **fizzle**.
- **Authority.** Each fighter's browser moves its own character immediately and sends its position 20 times a second. The server limits speed (a small allowance for network jitter), keeps both on the helipad and apart, judges every hit with its own positions, and sends both positions to everyone 20 times a second. A browser too far from the server's position is pulled back.
- **Cameras.** Fighters: behind their own shoulder, locked on to the opponent. Spectators: from the side, framing both. **Watch** on the fight card enters the arena; **Leave** (or Esc) returns to the office, and spectators return automatically when the duel is over.
- **Unchanged.** Consent, challenges, stats, gear effects, records, controls (J, K/Shift, Q, mouse).
- **Balance.** The bot simulation gains movement: approaching, stepping out of reach, and sidestepping blasts. The targets in section 4 still apply.

### Phase 1.1 as built

- New: `src/world/arena.js` (the rooftop scene), `src/ui/duelArena.js` (being in the arena: camera, your movement, keeping the office's controls out). `src/sim/duel.js` now hides the two office characters and drives the two arena fighters. The office rings (`world/furniture/duelRing.js`) are gone.
- The arena is built and its shaders compiled in idle time a few seconds after the office loads, so the first duel does not stall.
- Server: `duel:move` (fighting connection only, during the fight, at most 30 a second); state goes out every tick with positions; phases are `intro` (4 s) then `fight`; up to 6 duels at once.
- Verified: `npm test` 144 pass (3 opt-in PostgreSQL skipped); in three headless browsers against the real server code: a challenge accepted from the panel takes both fighters to the arena (countdown, "Fight!"), the fighter's office character vanishes with the status "In a duel with … on the rooftop", a third person watches from the office with **Watch on the rooftop** and sees **Back to the office**, movement reaches the server and the other screens, out-of-reach strikes show **Miss**, a KO ends it for all three, one result is saved, and everyone is back in the office with the office character at work again. No console errors.
- Not verified: real accounts and real GPUs. In software rendering the arena ran at a few frames a second; a normal GPU should be smooth, but check on the slowest laptop in the office.

## Phase 1.2: weapons (requested 2026-11-19)

A fourth Marketplace slot, **weapon**, held in the right hand. Weapons are the most expensive items (1,800–4,000 coins) and change how your strike works, not just your attributes. With no weapon you fight with fists, as before.

| Weapon | Kind | Price | Strike | Notes |
|---|---|---|---|---|
| Hotfix Katana | sword | 1,800 | reach 2.2 m, ×1.1 damage | fast and safe |
| Archive Staff | staff | 2,200 | reach 2.6 m, ×1.1 damage | longest melee reach |
| Merge Conflict Hammer | hammer | 2,400 | reach 2.0 m, ×1.3 damage, 0.6 s wind-up, slower cooldown | big hits |
| Monolith Greatsword | greatsword | 2,600 | reach 2.5 m, ×1.25 damage, 0.6 s wind-up, slower cooldown | |
| Pulse Pistol | gun | 2,800 | 14 m/s bolt, ×0.75 damage, quick wind-up | you move at 85% |
| Ion Rifle | gun | 4,000 | 16 m/s bolt, ×1.15 damage, 0.55 s wind-up | you move at 80% |

- Guns are stylized energy weapons (glowing bolts), not realistic firearms.
- The server knows each fighter's weapon from the database (like their other gear), so a browser cannot pick its own.
- Bolts work like Focus Blast: aimed where the target stood, judged on arrival. Unlike a blast they can be dodged by AGI, a guard stops most of one (15% gets through), and a perfectly timed guard **deflects** it (no damage, the shooter is staggered).
- Balance: the bot simulation learns to use reach (spacing) and guns (keeping distance, sidestepping bolts). Targets: any weapon alone beats fists 55–70% between equals; weapons against each other stay within 35–65%; a full set with the best weapon beats base gear at most ~85%, and a skilled player in base gear still wins at least ~40% against an average player in it.
- Database: migration `202611190002_marketplace_weapons.sql` adds the slot (catalog check, an equipment column, the equip and snapshot functions) and a new `office_market_appearances_full()`; older migrations and functions are left as they are.

### Phase 1.2 as built

- Tuning took several rounds. First values made guns win 98–99% against fists (a shooter could back away forever); fixes: guns slow you down, bolts are slower and smaller, a timed guard deflects them. The bots also learned to dodge diagonally forward and to sidestep slower bolts more easily, as a person would.
- Results (300–400 seeded duels each): each weapon alone vs fists between equals 49–67%; weapons against each other 44–73% (no hard counters); a full set with a weapon vs base gear 70–89%.
- **Honest limit:** against guns, the *shooter's* skill decides (a novice with a pistol beats an average fist-fighter about 2% of the time, a skilled one about 86%), but the target's skill helps little, so a skilled player in base gear wins only about 15–30% against an average player with a full set and a gun. Against melee weapons that figure stays around 60%. Weapons cost 1,800–4,000 coins on top of a ~3,500-coin set, so this is end-game gear; revisit if guns feel unfair in practice.
- Tests: weapon rules in `server/duelEngine.test.js`; weapon balance (each alone, every pairing, full set with each weapon, and that skill matters for every weapon) in `server/duelBalance.test.js`; the migration on real PostgreSQL (run twice, buy and equip a katana, wrong slot and unowned refused, the weapon in the shared appearance, the original appearance function intact) in `supabase/tests/marketplace_session_access.sql`.
- Checked in headless browsers: the Weapons tab, a katana vs pulse pistol duel on the rooftop (Slash / Shoot buttons, bolts, misses, a KO), no console errors.

### Jump (added and removed 2026-11-19)

- **Space** (or the Jump button) jumps: 0.55 s in the air, 0.75 m high, once every 1.3 s. Anything fired (Focus Blast or a gun's bolt) that arrives while you are in the air flies under you ("Jumped!"); melee still hits you in the air; no striking, casting or guarding mid-air. The server decides it like every other action (`jump` input, `jump` event to everyone).
- It gives the target of a gun a skill answer: with bots that jump some of the time, a skilled player in base gear now wins about 25–27% against an average player with a full set and a gun (was 15–17%). All balance targets still pass.
- Checked: engine test (blast and bolt cleared mid-air, melee still hits, no acting mid-air, cooldown); in headless browsers six jumps reached the other screen and five pistol bolts were jumped over.
- **Removed** the same day at the user's request. Its balance effect is gone with it: against an average player with a full set and a gun, a skilled player in base gear is back to about 15–17%.
- While investigating "can't walk up to the opponent" (reported on the Render deployment), the real cause turned out to be unrelated to the jump: the browser compared the server's (slightly delayed) position for you with where you are *now* and pulled you back whenever they differed by 0.6 m, which on a real network was most of the time. Now it compares with the positions it recently sent and only snaps back when the server really corrected you (`reconcile` in `ui/duelArena.js`). Verified with a simulated 150 ms and 300 ms delay: both fighters walk right up to each other.

## Weapon motion and local practice (2026-11-19)

**Weapons look like they hit.** Blades leave the fist angled forward like a real grip; guns line up with the arm
(`character/equipment.js`), and every weapon has a tip (blade end, hammer head, muzzle).
- Sword: cocked back over the head during the wind-up, then a diagonal slash down through the opponent, landing as the
  server's hit lands, with a light trail behind the blade tip and a spark where it meets them. Greatsword and hammer:
  the same, two-handed. Staff: drawn back, then a forward thrust.
- Guns: the arm comes up and aims at the opponent (the other hand steadying it), the bolt leaves the muzzle with a flash
  and a glowing trail, and the shot kicks the arm back.
- A hit you deal or take shakes the camera briefly (not for people who turn off motion).
- Poses: `people/animation.js` (`duelSlash`, `duelSlashFollow`, `duelThrust`, `duelThrustHit`, `duelAim`, `duelShoot`,
  `duelReadyBlade`, `duelReadyGun`), chosen by `sim/duel.js` from the fighter's weapon and how far through the wind-up
  or follow-through it is; trails and shake in `ui/duelArena.js`; muzzle flash and sparks in `ui/duel.js`.

**Practice against a bot, local only.** With `npm run dev`, the Duel panel shows **Practice · local only**: pick your
weapon (any weapon, owned or not), the bot's weapon and its skill, and the duel starts at once on the rooftop against
the Sparring Bot (the balance-test bot, `server/duelBots.js`, playing live). Others can watch. Results are never saved.
- Only `vite.config.js` turns it on, for the dev server (`configureServer`); `npm run preview` and the production server
  (`server/index.js`, which Render runs) never do, and the hub also refuses it when `RENDER` is set. Without it the
  server answers "Practice duels are only available when running locally" and the panel section stays hidden.
- Tests: `server/duel.test.js` (off by default; on: starts at once, the bot moves and attacks, your weapon can be
  overridden, nothing saved).
