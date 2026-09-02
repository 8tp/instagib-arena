# Critique harness — how to screenshot the live game

Dev server: `npm run dev` (vite :5173, game server :8787). Solo vs Bots needs no server.

## Photo mode (dev only)
Open `http://localhost:5173/play?photo=1`, click **Solo vs Bots** → **Start match**. In photo
mode the game: (1) treats the pointer as locked (automation can't get a real lock), so the
warmup runs and bots fight; (2) keeps rendering while the tab is hidden (Chrome pauses rAF
for background tabs — photo mode swaps to a MessageChannel loop while `document.hidden`).

The click-to-play overlay still mounts. Strip its blur from the console before a screenshot:
```js
const h=[...document.querySelectorAll('h1,h2,div,p')].find(e=>e.childElementCount===0&&/click to play/i.test(e.textContent||''));
let el=h,ov=null; while(el&&el!==document.body){const cs=getComputedStyle(el);
 if((cs.position==='fixed'||cs.position==='absolute')&&cs.backdropFilter!=='none'){ov=el;break;} el=el.parentElement;}
if(ov){ov.style.backdropFilter='none';ov.style.background='transparent';[...ov.children].forEach(c=>c.style.visibility='hidden');}
```

## Live handle: `window.__ig` (the Game instance)
- `__ig.setPlayerView(yaw, pitch, {x,y,z}?)` — aim / teleport the first-person camera.
- `__ig.setPostFx({bloom, shadows, aa, vignette})`, `__ig.setViewmodelMotion(0..1)`,
  `__ig.setQuality(resolutionScale, lowSpec)`, `__ig.setFpsLimit(n)` (−1 uncapped, 0 vsync).
- `__ig.player.pos / yaw / pitch`, `__ig.scene`, `__ig.renderer`, `__ig.postFx.opts`.
- Bloom/shadow constants: `BLOOM_TUNING`, `SHADOW_TUNING` in `src/game/renderer.ts`.

## Scenes worth capturing
1. Spawn wide shot (shadows + trim + sky). 2. Mid-fight with a rail beam + impact.
3. Kill burst. 4. Viewmodel idle + after firing. 5. `/lockerlab` (hats, unusual particles).
6. Lobby, Settings, Locker, Leaderboard, Onboarding (`localStorage.removeItem('instagib-onboarded')`).
Name files `design/shots/<track>-r<round>-<scene>.jpg`.
