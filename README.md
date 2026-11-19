# Jakogami

A 3D office floor simulation (Three.js, built with Vite). Staff follow daily schedules; the launch interface focuses on viewing the office and employee presence. Characters come from a chibi + blocky character pack.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # outputs dist/
npm start          # production server: dist/ + the /api BFF (honours $PORT; used on Render)
```

Supabase is reached only through the BFF in `server/`; copy `.env.example` to `.env` and fill in the server-only keys for the **same Supabase project as the dashboard**. Without configuration, login and office data remain unavailable; there is no demo login or made-up staff fallback.

## Login

Use your existing dashboard email/password. Office Floor owns a separate cookie-based session: dashboard login does not automatically sign you into this origin. Only verified `profiles` with role `employee` or `super_admin` can enter. Tokens stay in HttpOnly, SameSite=Lax cookies; production cookies are Secure. The scene and office data load only after session restoration succeeds, and sign-out or lost session clears the scene.

Set `APP_ORIGIN` to the exact public Office Floor origin on a deployed service. See [deployment security and account-policy notes](docs/DEPLOYMENT.md#authentication-and-security) before launch. Run the isolated mocked API suite with `npm test`. Browser/real-account acceptance testing is separate.

The employee roster is read from `public.profiles` (`id`, `full_name`, `role`), filtered to `role = 'employee'`; `id` is the same user ID used by `public.calendar_entries.user_id`. Today's in-office list includes only entries whose date is today in Manila and whose status is `in_office`. The initial desk assignments follow the reference floor-plan image in `src/config/desks.js`; both crossed-out cubicle stations and the workstation marked vacant are removed from the scene.

Deploying: see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). On Render, build with `npm install && npm run build`, start with `npm start`, and set `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `APP_ORIGIN`.

## Controls

- **Office camera:** drag to move, right-drag or Shift-drag to turn and tilt, wheel or pinch to zoom, `H` hides the HUD. Click a person to see what they are doing.
- **Walk:** **Walk** in the dock walks you around the office as yourself, in third person (`V` first person, `Esc` exit). If your employee is in the office you take them over where they are; otherwise your own character (your look and equipped gear) appears at the entrance. Only you see yourself walk for now.
- **Launch scope:** the View selector, Character lab, Chat, and Power Slap controls are removed from the live interface. Their reusable source modules remain for future work; chat/Power Slap server attachments are disabled in production, development, and preview.
- **Marketplace:** open it in the dock to browse outfits, armor, and pets, try them on, buy with coins, and equip owned items. Each account receives 3,000 coins once. Purchases and equipment persist in Supabase; Optional **Earn Coins** lets a connected Jira account earn coins for verified Done tickets; see [Jira setup](docs/DEPLOYMENT.md#jira-earn-coins-setup-optional). Apply the [Marketplace SQL migration](docs/DEPLOYMENT.md#marketplace-setup) before using purchases.
- **Duel:** challenge a coworker who is online from **Duel** in the dock, their person card, or by looking at them while walking and pressing `G`. Nothing happens unless they press **Accept**; **Available for duels** turns challenges off. Accepting takes both fighters to a separate arena on the **office rooftop at dusk**; their office characters vanish until it is over, and anyone online can **Watch** from the fight card. Fights are real time and refereed by the server: `WASD` moves you (locked on to your opponent), `J`/left click strikes (within about 1.8 m), `K`/`Shift`/right button guards (just in time: a parry), `Q` casts Focus Blast, which can be sidestepped. Equipped gear shapes the fighters a little; skill decides most fights. Records (W–L–D) show on person cards. No coins change hands. Running locally with `npm run dev`, the Duel panel also offers **Practice · local only**: a duel against a sparring bot that starts at once, with any weapon for you and the bot (never saved, and never available on Render). See [docs/DUEL-SPEC.md](docs/DUEL-SPEC.md) and the [Duel setup](docs/DEPLOYMENT.md#duel-setup).
- **Hours:** people work through their shifts, take breaks, and have lunch at the kitchen table. The clock runs a full day, 06:00 to 06:00.
- **Desks:** four central desk banks (A–D) and four individual workstations: Christian's standalone station (V) and W–Y along the upper wall. The two crossed-out cubicle stations and the workstation marked vacant are physically removed. Saved character-lab desk choices apply to employees without a reference-image assignment.
- **Clock:** When Supabase calendar data is available, **Live** is the default: it follows the actual time in Manila and shows employees whose `calendar_entries` status for today is `in_office`. **Simulate** runs the office's own faster clock (pause, 1×/3×/8×) for employees on their shifts, starting the **Day** or the **Night**. If calendar data is unavailable, the app starts in Simulate mode.
- **Lights:** click **Lights on / Lights off** in the dock to toggle indoor lighting independently of the time of day. Lights start on, work while paused, and remember your choice in this browser.
- **Find someone:** type a name in the search box; pick them to fly to them and open their read-only card. **Follow** keeps the camera on that employee.

## Marketplace

The shop has independent **Outfit**, **Armor**, **Pet**, and **Weapon** slots. Weapons are the expensive end of the shop (1,800–4,000 coins) and change how you fight in duels: swords, a staff and a hammer reach further or hit harder; the stylized Pulse Pistol and Ion Rifle fire bolts but slow you down. **Try on** is preview-only; it never spends coins or changes anyone in the office. **Buy item** opens a confirmation, adds the item to your inventory, and does not automatically equip it. Use **Equip**, **Unequip**, or a slot's **Remove** button to change your look.

Every item lists **Strength (STR)**, **Agility (AGI)**, and **Intelligence (INT)** bonuses. Characters start with 10 in each attribute; only equipped items contribute bonuses, one per slot. Replacing or removing gear recalculates totals from scratch, so bonuses cannot accumulate accidentally. The character panel shows base points, gear bonuses, and totals; try-on projections are explicitly marked and do not change the actual character. These values are also returned by the server and shown on employee cards.

No additional SQL is required for attributes: base points and item bonuses are defined in the shared server catalog, and totals are derived from persisted equipped item IDs. Changing an item's balance updates its bonuses on the next refresh without rewriting account records. In duels, attributes become health, damage, strike speed, dodge, mana and Focus Blast (`duelStats` in `src/config/duel.js`); the server reads equipped items from the database at the start of each duel, so browsers cannot change them.

Your base character, face, hair, body, and desk are preserved. The preview works even if you are absent or do not have an assigned station; shopping never adds you to the office. Equipped looks apply to your account's character only. Other viewers see updates on the next appearance refresh (about one minute, or use **Refresh** in the shop).

Wallets and inventory are not stored in localStorage. The server uses your existing Supabase configuration and the verified user's session to call account-bound database functions, with row locks, database-owned prices, and duplicate-purchase protection. Apply the Marketplace migrations in order: `202611090001_marketplace.sql`, `202611090002_marketplace_session_access.sql`, then `202611190001_marketplace_items.sql` for the volume 2 items, then `202611190002_marketplace_weapons.sql` for weapons. If some are already installed, run only the ones that are not (each is safe to rerun). No replacement key is needed. Switching accounts in another browser tab invalidates stale Marketplace actions before coins are spent. A missing migration shows a setup-required message rather than a pretend balance.

## Documentation

Start with [`docs/`](docs/README.md). It sets the standard for how this codebase is organised and changed.

| | |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layers, folder map, startup order, state ownership |
| [docs/CODING-STANDARDS.md](docs/CODING-STANDARDS.md) | rules for new code and the checklist before you push |
| [docs/HOW-TO.md](docs/HOW-TO.md) | recipes: furniture, activities, camera views, looks, HUD controls |
| [docs/MIGRATION.md](docs/MIGRATION.md) | moving work from the old single `index.html` |
| [docs/ROADMAP.md](docs/ROADMAP.md) | planned features and follow-ups |

## At a glance

`index.html` is markup only. `src/entry.js` starts the auth gate; `src/ui/auth.js` restores the session before dynamically importing the scene. `src/bootstrap.js` is the one place the scene is assembled. `src/main.js` owns scene startup/cleanup and the frame loop. Code lives in `config/ core/ render/ world/ nav/ character/ people/ sim/ player/ camera/ fp/ ui/ styles/`; see the folder map in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#folder-map-src).
