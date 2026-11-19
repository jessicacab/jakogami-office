-- Marketplace volume 2: nine more items. Run after 202611090001_marketplace.sql (and its session-access update) in
-- the SAME Supabase project. Additive and rerunnable: it only adds or refreshes these catalog rows; nobody's coins,
-- inventory or equipment change. Keep in step with src/config/marketplace.js (prices must match exactly, or
-- purchases fail with catalog_changed).
begin;

insert into public.office_market_catalog (id, name, slot, price, rarity, description, color, accent, model)
values
  ('outfit-hoodie', 'Night Shift Hoodie', 'outfit', 300, 'Common', 'A soft navy hoodie for late deploys. A little of everything.', '#3b4a6b', '#9fb4d9', 'hoodie'),
  ('outfit-track', 'Sprint Tracksuit', 'outfit', 650, 'Rare', 'A green tracksuit with white stripes, built for speed.', '#2f8f6b', '#f2f2f2', 'hoodie'),
  ('outfit-suit', 'Boardroom Suit', 'outfit', 750, 'Rare', 'A charcoal suit with gold trim that thinks three moves ahead.', '#2b2f3a', '#c9a85b', 'coat'),
  ('armor-vest', 'Debugger''s Vest', 'armor', 650, 'Uncommon', 'A padded olive vest with pockets for everything.', '#5d6b4a', '#d8c79a', 'vest'),
  ('armor-circuit', 'Circuit Mail', 'armor', 1300, 'Epic', 'Teal plating traced with glowing circuits.', '#2a6f86', '#7ef0e0', 'vest'),
  ('armor-obsidian', 'Obsidian Bulwark', 'armor', 1400, 'Epic', 'Heavy black plate with a red core. Pure strength.', '#2c2a33', '#e0524a', 'plate'),
  ('pet-cat', 'Desk Cat', 'pet', 550, 'Uncommon', 'An orange office cat who has seen every bug.', '#e0a15a', '#fff1dc', 'cat'),
  ('pet-drone', 'Hover Drone', 'pet', 950, 'Rare', 'A quiet little quadcopter that scouts ahead.', '#c9d1d9', '#4fb3ff', 'drone'),
  ('pet-ember', 'Ember Wisp', 'pet', 900, 'Rare', 'A warm floating spark with a strength bonus.', '#f08a4b', '#ffd9a8', 'wisp')
on conflict (id) do update set
  name = excluded.name,
  slot = excluded.slot,
  price = excluded.price,
  rarity = excluded.rarity,
  description = excluded.description,
  color = excluded.color,
  accent = excluded.accent,
  model = excluded.model;

notify pgrst, 'reload schema';
commit;
