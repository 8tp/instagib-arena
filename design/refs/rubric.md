# Critic rubric — arena-FPS quality bar

The critic sees only screenshots (ours in `design/shots/`, references in `design/refs/`) and
this rubric. It never sees the builder's reasoning. It answers ONE question per scene:
**"Blind, which frame is closer to a shipping arena FPS (Diabotical / Quake Champions /
Splitgate 2): ours or the reference?"** Then names the SINGLE largest gap. No scores.

## In-match (3D)
- Grounding: do players and cover cast readable shadows? Do surfaces meet the floor or float?
- Light: is there a key/fill relationship, or flat ambient? Do emissives glow (bloom) while
  walls stay clean? Any blown-out white or crushed black?
- Surfaces: edge definition (normal maps), roughness variation, restrained trim emissives.
  Busy noise that hides enemies is a FAIL regardless of prettiness.
- Weapon: does the railgun read as a machine (materials, glow, silhouette)? Does it sit still
  enough for aiming? Is there life (bob/sway) in the idle frame?
- Enemies: readable at 30 m against every wall colour; visible aim/pose; death is an event,
  not a vanish.
- Effects: rail beam crisp with a hot core; impact has a spark + decal; muzzle is a discharge,
  not a sphere. Nothing lingers long enough to obscure the crosshair line.
- AA: no crawling edges on cover corners; no shimmer on rails.

## Front-end (2D)
- One language: every modal, button, input, tab, row uses the deck primitives. A single
  `rounded-2xl` glass panel next to a clipped deck panel is a FAIL.
- Hierarchy: one memorable element per surface; everything else quiet. Type does the work.
- Motion: entrances + exits both exist, short, purposeful; nothing animates at 20 fps steps.
- Feedback: toast on confirm; skeleton while loading; sound on click; focus ring visible.
- Copy: sentence case, active voice, buttons say what happens ("Save changes", not "OK").
- Anti-slop: no purple gradients, no ALL-CAPS eyebrow label above every heading, no '→' on
  buttons, no hover-lift on every card, no scattered fade-up.

## Verdict format
```
scene: <name>
winner: ours | reference
largest gap: <one sentence, concrete, points at a thing on screen>
secondary: <optional, one line>
```
