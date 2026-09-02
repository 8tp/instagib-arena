# Instagib Arena — working notes for Claude

Browser instagib FPS. Three.js 0.184 (WebGL) client + React 19 / Tailwind 4 UI, Node
`ws` server, SQLite. Live at instagib.win on Railway. Architecture: `docs/ARCHITECTURE.md`.
Roadmap: `docs/ROADMAP.md`.

## Commands
- `npm run dev` — vite + server (`tsx watch server/index.ts`).
- `npm run typecheck && npm run lint` — must pass before any commit. `npm run build` for a
  production bundle check.
- No test suite. Verification is typecheck + lint + build + a visual check.

## Visual test scenes
- `/play` → Solo vs bots (offline; no server needed) for in-match visuals and HUD.
- `/lockerlab` — cosmetic preview harness. `/podiumlab` — end-of-match podium harness.
- Screenshots for critique go in `design/shots/`. Reference images live in `design/refs/`.

## Hard rules
- Skill stays sacred: nothing cosmetic may affect aim, movement, hit detection, or visibility
  in a way that is an advantage. Server is authoritative; the client never reports scores/XP.
- All juice is frame-rate independent: use `1 - Math.exp(-k * dt)` smoothing, never
  per-frame constants. Respect the `reducedEffects` and `lowSpec` settings and the
  `effects.setQuality()` knob; expensive visuals must degrade on the low tier.
- The 3D loop runs full-rate; the React HUD receives a `HudState` at ~20 Hz. Never drive
  60 fps motion from React state — use CSS animations keyed by id, or the 3D loop.
- No new runtime npm dependencies without asking. Prefer `three/addons`.
- Dispose geometry/materials you create; share via `userData.shared` where cloned.

## Scope
Deliver what was asked at the scope intended. If you find a pre-existing bug, perf issue,
or behavior the task doesn't mention, don't fix or extend it in this change unless the
requested behavior cannot work without it; report it as a follow-up. Where the task is
ambiguous, implement the reading the surrounding code most directly supports and state the
assumption. Prefer targeted edits over whole-file rewrites; `src/InstagibClient.tsx` is
large, edit surgically.

## Subagents
Delegate only for large, genuinely independent tracks (one owner per file; never split a
file across two builders). Don't use subagents to verify your own work — use typecheck,
lint, build, and screenshots. For visual work, a *fresh-context* critic that sees only
screenshots plus the references in `design/refs/` is the review mechanism.
