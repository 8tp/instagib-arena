# Map redesign brief (2026-09 overhaul)

The current arenas were too small and too flat: everyone sees everyone, spawns are
in each other's sightlines, and there is nowhere to go *up*. Duel maps were 26×22 m and
24×24 m — at 10 m/s you cross them in 2.5 s. This overhaul makes every arena bigger, taller
and more deliberate, with high ground worth fighting for. Looks get the same treatment:
brighter, more readable, with a clear identity per map.

## Movement you are designing for (src/game/constants.ts)
- Walk 10 m/s (Q3-scale; 1 m ≈ 31 Q3 units ≈ 43 UT units). Strafe-jumping goes faster.
- Jump ≈ 1.6 m high, ≈ 0.72 s airtime (≈ 7 m flat at walk speed). **Double jump** ≈ 3.2 m.
- **Boost** (right mouse): aim at any surface ≤ 4 m away → 20 m/s along its normal (+ forward
  bias). Floor boost ≈ 8 m up; wall boost launches you off the wall; chainable every 0.3 s.
- Dash 22 m/s for 0.15 s (≈ 3.3 m), 2.5 s cooldown. Wall-jump off any wall.
- **No step-up.** A player cannot walk up even a 0.2 m lip; every rise is a jump. Stairs are
  "jump-steps" (risers ≤ 1.2 m, `steps()` in `src/game/maps/kit.ts`). Keep travel routes
  free of accidental 0.1–0.9 m lips.
- Instagib railgun: one hit kills, 1.2 s cooldown, 200 m range, rails pass through anything
  that is not a collision box.
- Up to 8 players in FFA/TDM (TDM uses the same spawn list — no team sides). Duel is 1v1.

## Scale targets (reference: Q3 duel maps ≈ 50–65 m, Longest Yard ≈ 85×55 m, UT Morpheus
≈ 115 m with 40 m towers; Ratz maps are giant-scale rooms with shelves/furniture stacked
into 3–4 play tiers — see `design/refs/ratz/`)
| | footprint (x × z) | walkable tiers | apex | cap (ceiling) |
| --- | --- | --- | --- | --- |
| Duel | 60–72 × 52–64 m | 0 / 1.2–3 / 4.5–7 / 9–12 | 13–16 m | ≥ apex + 10 m |
| FFA/TDM (≤ 8 players) | 88–104 × 64–80 m | 0 / 1.2–3 / 4.5–7 / 9–12 / 14–18 | 16–22 m | ≥ apex + 10 m |

## Layout principles
1. **Zones, not a box.** Divide the volume into 4–7 readable zones (rooms, courts, towers,
   yards) with 2–3 connections each. Use full-height or ≥ 3 m tall solids to break sight.
   Long rail lanes (40–60 m) must exist — they are the fun of instagib — but each one is
   broken by partial cover and has a flank.
2. **Verticality with purpose.** Each tier is a real place to fight from, not a ledge. At
   least ~30 % of the raised top area should be mid-tier (4.5–7 m) or higher.
3. **Vantage points are strong but answerable.** Every high perch is reachable ≥ 2 ways, is
   visible from ≥ 2 other positions, and can be approached from cover. No enclosed sniper
   nests. One contested **power position** (apex) per map, usually on the central axis.
4. **Traversal is skill-expressive.** Main routes by jump-steps / double jump; shortcuts and
   the apex by boost (a launch surface ≤ 4 m from the target ledge) or strafe gaps of
   7–16 m. Everything raised is reachable (map-check reports it).
5. **Flow in loops.** No dead ends. Figure-8s and rings. ≥ 3 routes between the spawn areas.
6. **Spawns.** Duel ≥ 8, FFA ≥ 14, spread over zones AND tiers (a few on mid decks), each
   with ≥ 1 m of clear, supported room around it (the server jitters ±0.5 m), ≥ 12 m apart
   where possible, not facing a wall < 3 m away. Spawn→spawn sightlines ≤ 25 %.
7. **Symmetry.** Duel maps: rotational (`sym(…, 'rot')`) or mirror symmetric — fairness.
   FFA maps may be asymmetric but balanced.
8. **Targets from `npx tsx scripts/map-check.ts <id>`:** openness 25–40 % (the old maps
   were 40–73 %), spawn→spawn ≤ 25 %, zero ERRORs, no unreachable surfaces, no stray-light
   WARNs, headroom ≥ 8 m.

## Look principles (per map "look": world/looks/<id>.ts)
- **Brighter and more readable than before.** The old arenas crushed into murk (albedo
  bases around 0x3a–0x55, dim ambient). Aim for mid-value albedos, a lit play space, clear
  key/fill, and dark only where it means something. Diabotical / Quake Champions / Ratz
  clarity — not a tech-demo cave.
- **Identity.** A palette and material set you could recognise from one screenshot. Ratz
  maps use strong, clean colour blocking at giant scale — furniture, shelves, toys.
- **Enemies stay the brightest, most saturated thing on screen.** Keep world saturation
  moderate, emissives restrained, and no busy high-frequency texture on large wall areas.
- **Textures** are procedural (`src/game/textures.ts` builders: panels, grating, planks,
  blocks, corrugation, tufts, flat/plaster, stains). You may write new field generators in
  your look file from the exported primitives. Up to 2 slots at 512², the rest 256².
  Generation ≤ 150 ms per theme, lightmap bake ≤ 600 ms per map (dev console `[world]`
  lines; `scripts/shot.mjs` prints them).
- Lights hang on real box faces (map-check verifies), dressing stays flush (≤ 0.15 m),
  free-standing props only outside the bounds.
- Tag boxes in the map module (`B(…, 'tag')`) and key slots / tints / lights off tags.
