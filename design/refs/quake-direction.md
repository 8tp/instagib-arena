# Direction: Quake instagib, not a tech demo

The bar is **Quake III Arena / Quake Live instagib**, with Quake Champions for modern material
quality and Diabotical for UI crispness. When a choice is unclear, ask: "would this look at
home in a Quake Live instagib server in 2026?" `design/refs/` has no images yet, so this file
describes the target in words. Critics judge against it plus `rubric.md`.

## What reads as "tech demo" today (the baseline)
- Grey tiled boxes everywhere; every map shares one texture set; the only per-map difference
  is the trim colour. Nothing explains where the light comes from; lighting is even and flat.
- Enemies are a small tan camo soldier that blends into the walls.
- The railgun is a boxy rectangle with a glowing strip.
- A kill is a character falling over, not an instagib.
- Sound is five procedural blips: no footsteps, jumps, landings, ambience.
- Menus look like a SaaS dashboard (panels, chat, tiny caps labels). No loading screen: you
  click and the world pops in.

## Pillars
1. **A place, not boxes.** Each map has a theme: material set, palette, light colour, sky.
   Surfaces read as built architecture: plinths/bases and caps on pillars, trims, panel seams,
   baseboards, light fixtures that justify the light. Lighting has pools and falloff, coloured
   sources, dark corners (AO), and contrast. Moody, but the play space stays readable.
2. **Readable enemies.** Bright, saturated combatants against a darker, lower-saturation world
   (Quake Live's forced bright skins). Armoured arena fighters with a clear silhouette: helmet
   with a glowing visor, shoulder plates, chest plate, a coloured stripe. No camo realism.
3. **The railgun is the star.** Iconic long silhouette, energy coils/rings whose glow shows the
   recharge, a beam with a white-hot core and a spiral or rings that fade, a crunchy discharge,
   and impact sparks plus a scorch mark.
4. **Instagib means gibs.** A kill bursts the body into chunks and energy, fast and punchy,
   without covering the crosshair line for long.
5. **Sound is half the feel.** A layered rail shot (thump, crack, ring tail), a crisp hit
   tick, movement sounds (jump grunt, landing thud, footsteps, dash whoosh), per-map ambience.
6. **Game UI, not a web app.** Big confident numerals, a Q3-style centre-print on frags
   ("You fragged Razor" / "1st place with 12"), a live 3D arena behind the menus, and a
   Q3-style loading screen (levelshot, map name, loading steps, "Awaiting snapshot…").

## Map themes (suggested, builders may refine)
| map | theme | notes |
| --- | --- | --- |
| causeway | **Void** (Longest Yard homage) | open sky: deep space, nebula, stars; dark gunmetal platforms with lit edges; violet/blue |
| reactor | **Reactor** | industrial tech: steel plate, grates, hazard stripes; cyan core glow, red warning lamps |
| lounge | **Lounge** (Ratz homage) | warm interior at giant scale: wood, fabric, lamp light |
| nuketown | **Dusk suburb** | low warm sun, long shadows, cool ambient |
| containeryard | **Night port** | rusted containers, sodium-orange floods, wet concrete |
| derrick | **Rust at dusk** | oxidised steel, orange sky, silhouetted structure |
| training | **Lab** | clean, bright, neutral; the exception to the moody rule |

## Anti-goals
- Flat, even lighting. Grey-on-grey. Everything the same roughness.
- Neon everything: emissives stay restrained so enemies are the brightest things on screen.
- Visual noise that hides enemies (busy high-frequency textures on walls behind players).
- SaaS dashboards, rounded glass chips, tiny all-caps labels everywhere, purple gradients.
- Decoration that changes sight lines: any non-colliding mesh must sit flush (≤ 0.15 m) to a
  collision surface or be outside the play space, because rails pass through it.

## Hard rules (from CLAUDE.md, repeated because they bind every track)
- Skill stays sacred: nothing cosmetic affects aim, movement, hit detection, or visibility as
  an advantage. Collision AABBs, spawn points, and movement constants do not change.
- Frame-rate independent juice (`1 - Math.exp(-k * dt)`). Respect `reducedEffects`, `lowSpec`,
  and `effects.setQuality()`; expensive visuals degrade on the low tier.
- 3D loop full-rate; React HUD at ~20 Hz; never drive 60 fps motion from React state.
- No new runtime npm dependencies. No downloaded third-party assets: everything procedural
  (textures, geometry, audio) unless the maintainer approves an asset.
- Dispose what you create.
