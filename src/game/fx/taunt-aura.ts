import * as THREE from 'three';
import { fxFlags } from './fx-settings';
import { lightningPath, RibbonBatch } from './ribbon';
import { CELL, unusualAtlas } from './unusual-atlas';
import { Field, GOLDEN, TAU, hash, hsv, mix, rnd, smooth, tmpVp, type SharedUniforms } from './unusual-core';
import type { EffectKind } from './unusuals';

// ── Unusual taunts ───────────────────────────────────────────────────────────
// The full-body variant of an unusual effect, played around a combatant for
// the length of an in-game taunt (emote): a glowing ground ring, a column of
// particles in the effect's own idiom (embers rise, snow falls, bolts leap,
// hearts float…) reaching ~2 m, and for some kinds rings that climb the body.
//
//   const aura = new TauntAura('embers');
//   character.root.add(aura.group);        // origin = the feet
//   aura.start(3);                          // begin (auto-ends after ≤ 3 s, hard cap 6 s)
//   aura.update(dt);                        // every frame; free while idle
//   aura.stop();                            // taunt cancelled / player died
//   aura.dispose();
//
// Everything is analytic in a world-space point cloud (no per-frame allocation,
// frame-rate independent). Fairness: particles stay within ~0.85 m of the
// body and 2.2 m of height, fade out as the camera gets close (fully gone at
// < 1.5 m) so a taunting player can never blind or cover someone next to
// them, and the whole thing is hard-capped in time. reducedEffects: fewer,
// slower, no flicker or bolts; lowSpec: half the particles.

type Mode = 'rise' | 'fall' | 'swirl' | 'inward' | 'wander';
type RGB = readonly [number, number, number];
type Style = {
  mode: Mode;
  cell: number;
  size: number; // particle diameter, m
  hot: RGB; // colour at birth (linear, HDR)
  cool: RGB; // colour at death
  ring: RGB; // ground ring
  rings: number; // rising rings (0–2)
  arcs: boolean; // jagged bolts from the ring up the body
  rate: number; // cycles per second
  turns: number; // swirl turns per life
  occlude: number;
  hue?: boolean; // prismatic: hue by phase
  bits?: boolean; // 0/1 glyphs
  spin?: number; // sprite spin (rad/s)
};

const S = (s: Style): Style => s;
const STYLES: Record<EffectKind, Style> = {
  embers: S({ mode: 'rise', cell: CELL.flame, size: 0.2, hot: [2.0, 1.2, 0.4], cool: [0.8, 0.12, 0.0], ring: [1.5, 0.5, 0.08], rings: 0, arcs: false, rate: 0.5, turns: 0.3, occlude: 0.5 }),
  orbit: S({ mode: 'swirl', cell: CELL.dot, size: 0.07, hot: [1.7, 2.2, 2.4], cool: [0.3, 1.0, 2.0], ring: [0.2, 0.8, 1.6], rings: 2, arcs: false, rate: 0.7, turns: 1, occlude: 0.4 }),
  halo: S({ mode: 'rise', cell: CELL.dot, size: 0.045, hot: [2.0, 1.6, 0.7], cool: [1.2, 0.8, 0.2], ring: [1.5, 1.1, 0.4], rings: 2, arcs: false, rate: 0.35, turns: 0.15, occlude: 0.2 }),
  storm: S({ mode: 'fall', cell: CELL.streak, size: 0.22, hot: [0.6, 0.85, 1.3], cool: [0.5, 0.7, 1.1], ring: [0.5, 0.7, 1.2], rings: 0, arcs: true, rate: 1.4, turns: 0, occlude: 0.25 }),
  aura: S({ mode: 'rise', cell: CELL.dot, size: 0.045, hot: [2.0, 1.6, 0.8], cool: [1.4, 1.0, 0.3], ring: [1.6, 1.15, 0.4], rings: 2, arcs: false, rate: 0.3, turns: 0.4, occlude: 0.3 }),
  plasma: S({ mode: 'swirl', cell: CELL.dot, size: 0.05, hot: [1.9, 1.5, 2.4], cool: [0.6, 0.3, 1.4], ring: [0.7, 0.3, 1.5], rings: 0, arcs: true, rate: 1.0, turns: 1, occlude: 0.2 }),
  prism: S({ mode: 'rise', cell: CELL.dot, size: 0.06, hot: [2, 2, 2], cool: [2, 2, 2], ring: [1, 1, 1], rings: 2, arcs: false, rate: 0.4, turns: 1.6, occlude: 0.2, hue: true }),
  galaxy: S({ mode: 'swirl', cell: CELL.glow, size: 0.09, hot: [1.4, 1.2, 2.0], cool: [0.5, 0.5, 1.5], ring: [0.5, 0.35, 1.2], rings: 0, arcs: false, rate: 0.5, turns: 1, occlude: 0.45 }),
  ghostfire: S({ mode: 'rise', cell: CELL.flame, size: 0.2, hot: [0.6, 1.8, 1.6], cool: [0.05, 0.6, 0.6], ring: [0.2, 1.1, 1.0], rings: 0, arcs: false, rate: 0.45, turns: 0.3, occlude: 0.5 }),
  hearts: S({ mode: 'rise', cell: CELL.heart, size: 0.14, hot: [1.6, 0.4, 0.8], cool: [1.4, 0.3, 0.6], ring: [1.3, 0.3, 0.6], rings: 0, arcs: false, rate: 0.3, turns: 0.3, occlude: 0.7 }),
  binary: S({ mode: 'fall', cell: CELL.zero, size: 0.075, hot: [1.6, 2.2, 1.75], cool: [0.14, 1.0, 0.38], ring: [0.2, 1.1, 0.4], rings: 1, arcs: false, rate: 0.5, turns: 0, occlude: 0.45, bits: true }),
  sunbeams: S({ mode: 'rise', cell: CELL.wisp, size: 0.34, hot: [1.9, 1.3, 0.5], cool: [1.0, 0.5, 0.1], ring: [1.7, 1.1, 0.3], rings: 1, arcs: false, rate: 0.35, turns: 0.1, occlude: 0.15 }),
  bubbles: S({ mode: 'rise', cell: CELL.bubble, size: 0.12, hot: [1.2, 1.4, 1.5], cool: [1.0, 1.2, 1.4], ring: [0.3, 0.9, 1.3], rings: 0, arcs: false, rate: 0.28, turns: 0.3, occlude: 0.3, hue: true }),
  frostbite: S({ mode: 'fall', cell: CELL.snow, size: 0.085, hot: [1.3, 1.6, 2.0], cool: [1.1, 1.4, 1.9], ring: [0.5, 1.1, 1.8], rings: 1, arcs: false, rate: 0.32, turns: 0, occlude: 0.35, spin: 1.3 }),
  voidrift: S({ mode: 'inward', cell: CELL.dot, size: 0.055, hot: [1.6, 0.6, 0.3], cool: [1.0, 0.6, 2.0], ring: [1.0, 0.3, 1.8], rings: 0, arcs: false, rate: 0.4, turns: 1, occlude: 0.4 }),
  fireflies: S({ mode: 'wander', cell: CELL.glow, size: 0.1, hot: [0.9, 1.4, 0.25], cool: [0.9, 1.4, 0.25], ring: [0.5, 0.8, 0.1], rings: 0, arcs: false, rate: 0.5, turns: 0, occlude: 0.35 }),
  cosmic: S({ mode: 'rise', cell: CELL.star, size: 0.1, hot: [1.9, 2.0, 2.6], cool: [0.9, 1.1, 2.0], ring: [0.4, 0.7, 1.6], rings: 1, arcs: false, rate: 0.28, turns: 0.5, occlude: 0.3, spin: 0.6 }),
  lightning: S({ mode: 'swirl', cell: CELL.dot, size: 0.045, hot: [2.2, 1.9, 1.0], cool: [1.4, 1.2, 0.5], ring: [1.5, 1.2, 0.4], rings: 0, arcs: true, rate: 1.2, turns: 1, occlude: 0.2 }),
  sakura: S({ mode: 'fall', cell: CELL.petal, size: 0.11, hot: [1.5, 0.65, 0.85], cool: [1.4, 0.6, 0.8], ring: [1.0, 0.35, 0.55], rings: 0, arcs: false, rate: 0.26, turns: 0.4, occlude: 0.6, spin: 2.2 }),
};

const H = 2.05; // column height (m)
const RAD = 0.8; // column radius (m)
const N = 56;
const MAX_SECONDS = 6;
const RING_R = 0.72;
const ARCS = 3;

export class TauntAura {
  readonly group = new THREE.Group();
  private readonly style: Style;
  private readonly f: Field;
  private readonly rib: RibbonBatch;
  private readonly u: SharedUniforms & Record<string, THREE.IUniform>;
  private t = 0;
  private env = 0; // fade envelope 0…1
  private on = false;
  private left = 0; // seconds until the auto-stop
  private ppm = 100;
  private readonly rank = new Float32Array(N);
  private readonly seed = new Float32Array(N * 7);
  private readonly arcT = new Float32Array(ARCS);
  private readonly arcPath = new Float32Array(ARCS * 10 * 3);
  private readonly arcF = new Float32Array(ARCS);

  constructor(kind: EffectKind) {
    this.style = STYLES[kind];
    this.group.name = 'taunt-aura';
    this.group.visible = false;
    this.u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as SharedUniforms & Record<string, THREE.IUniform>;
    this.u.uAtlas = { value: unusualAtlas() };
    this.u.uViewH = { value: 900 };
    this.u.uMinPx = { value: 1.5 };
    this.u.uGain = { value: 1 };
    this.u.uHdrCap = { value: 2.4 };
    this.u.uMinLum = { value: 0 };
    this.u.uOcclude = { value: this.style.occlude };
    this.u.uNear = { value: 1.5 }; // gone at < 1.5 m, full at 3 m
    this.f = new Field(N, this.u, true);
    this.f.setBounds(0, 1.0, 0, 2.4);
    this.rib = new RibbonBatch(3 + ARCS, 40, 1.6);
    this.rib.mesh.matrixAutoUpdate = false;
    this.rib.mesh.matrixWorldAutoUpdate = false;
    this.group.add(this.f.points, this.rib.mesh);
    for (let i = 0; i < N; i++) {
      this.rank[i] = (i * GOLDEN) % 1;
      for (let k = 0; k < 7; k++) this.seed[i * 7 + k] = hash(i * 7.31 + k * 3.7 + 0.5);
    }
    this.f.points.onBeforeRender = (renderer, _s, camera) => {
      renderer.getCurrentViewport(tmpVp);
      const vh = Math.max(1, tmpVp.w);
      const ce = camera.matrixWorld.elements;
      const e = this.group.matrixWorld.elements;
      const d = Math.max(0.5, Math.hypot(ce[12] - e[12], ce[13] - (e[13] + 1), ce[14] - e[14]));
      const p11 = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
      const ppm = (p11 * vh * 0.5) / d;
      this.u.uViewH.value = vh;
      // Whole-body scale: gains fall with distance like the crowns' (a far
      // taunter stays under the bloom threshold).
      this.u.uGain.value = 0.55 + 0.45 * smooth(6, 40, ppm);
      this.u.uHdrCap.value = 1.0 + 1.3 * smooth(8, 60, ppm);
      this.u.uMinLum.value = 0.8 * (1 - smooth(15, 60, ppm));
      this.f.mat.uniformsNeedUpdate = true;
      this.ppm = ppm;
    };
    this.group.traverse((o) => {
      o.userData.shared = true;
    });
    for (let k = 0; k < ARCS; k++) this.arcT[k] = rnd() * 0.1;
  }

  get active(): boolean {
    return this.on || this.env > 0.001;
  }

  // Begin the aura for `seconds` (the taunt's length; capped at 6 s).
  start(seconds = 3): void {
    this.on = true;
    this.left = Math.min(MAX_SECONDS, Math.max(0.5, seconds));
    this.group.visible = true;
  }

  // Fade out (taunt over / cancelled / died).
  stop(): void {
    this.on = false;
  }

  update(dt: number): void {
    dt = Math.max(0, Math.min(dt, 0.1));
    if (this.on) {
      this.left -= dt;
      if (this.left <= 0) this.on = false;
    }
    const target = this.on ? 1 : 0;
    // Fade in over ~0.35 s, out over ~0.5 s.
    this.env += (target - this.env) * (1 - Math.exp(-(target > this.env ? 9 : 6) * dt));
    if (!this.on && this.env < 0.004) {
      this.env = 0;
      if (this.group.visible) {
        this.group.visible = false;
        this.f.hideAll();
        this.f.commit();
      }
      return;
    }
    this.group.visible = true;
    const calm = fxFlags.reduced;
    this.t += dt * (calm ? 0.6 : 1);
    const st = this.style;
    const t = this.t;
    this.group.updateWorldMatrix(true, false);
    const e = this.group.matrixWorld.elements;
    const ox = e[12], oy = e[13], oz = e[14];
    this.f.setBounds(ox, oy + 1.0, oz, 2.4);
    let frac = this.ppm >= 40 ? 1 : this.ppm >= 15 ? mix(0.5, 1, (this.ppm - 15) / 25) : 0.35;
    if (fxFlags.low) frac *= 0.5;
    if (calm) frac *= 0.6;
    const f = this.f;
    const rib = this.rib;
    const env = this.env;
    rib.begin();
    // Ground ring (strip 0): a bright rim that breathes and slowly turns its
    // brighter arc; rising rings (strips 1–2) climb the body.
    const rc = st.ring;
    for (let j = 0; j < 40; j++) {
      const a = (j / 39) * TAU;
      const arc = 0.6 + 0.4 * Math.cos(a - t * 1.6);
      const k = env * arc * (1.3 + 0.2 * Math.sin(t * 3));
      const c = st.hue ? hsv((a / TAU + t * 0.15) % 1, 0.85, 1.4) : rc;
      const cr = st.hue ? c[0] : rc[0], cg = st.hue ? c[1] : rc[1], cb = st.hue ? c[2] : rc[2];
      rib.push(0, ox + Math.cos(a) * RING_R, oy + 0.03, oz + Math.sin(a) * RING_R, cr * k, cg * k, cb * k, 0.02);
    }
    for (let r = 0; r < st.rings; r++) {
      const ph = (t * 0.45 + r * 0.5) % 1;
      const y = 0.1 + ph * (H - 0.15);
      const rr = RING_R * (0.75 - 0.15 * ph);
      const al = env * Math.sin(Math.PI * ph);
      for (let j = 0; j < 40; j++) {
        const a = (j / 39) * TAU + r;
        const cr = st.hue ? hsv((a / TAU + t * 0.2) % 1, 0.85, 1.3) : rc;
        rib.push(1 + r, ox + Math.cos(a) * rr, oy + y, oz + Math.sin(a) * rr, (st.hue ? cr[0] : rc[0]) * al * 0.9, (st.hue ? cr[1] : rc[1]) * al * 0.9, (st.hue ? cr[2] : rc[2]) * al * 0.9, 0.014);
      }
    }
    // Bolts (storm / plasma / lightning): jagged strips from the ring up the body.
    if (st.arcs && !calm) {
      const n = fxFlags.low ? 2 : ARCS;
      for (let k = 0; k < n; k++) {
        this.arcT[k] -= dt;
        if (this.arcT[k] <= 0) {
          this.arcT[k] = 0.05 + rnd() * 0.06;
          const a = rnd() * TAU;
          const ex = Math.cos(a) * RING_R * (0.4 + rnd() * 0.5), ez = Math.sin(a) * RING_R * (0.4 + rnd() * 0.5);
          lightningPath(this.arcPath.subarray(k * 30, k * 30 + 30), 10, Math.cos(a) * RING_R, 0.03, Math.sin(a) * RING_R, ex, 0.6 + rnd() * 1.4, ez, 0.16);
          this.arcF[k] = rnd() < 0.3 ? 0 : 0.7 + rnd() * 0.3;
        }
        const fl = this.arcF[k] * env;
        if (fl <= 0) continue;
        for (let j = 0; j < 10; j++) {
          const o = k * 30 + j * 3;
          const u = j / 9;
          rib.push(3 + k, ox + this.arcPath[o], oy + this.arcPath[o + 1], oz + this.arcPath[o + 2],
            rc[0] * 1.6 * fl * (1 - u * 0.4), rc[1] * 1.6 * fl * (1 - u * 0.4), rc[2] * 1.6 * fl * (1 - u * 0.4), mix(0.02, 0.008, u));
        }
      }
    }
    rib.commit();
    // Particles.
    const rate = st.rate * (calm ? 0.7 : 1);
    for (let i = 0; i < N; i++) {
      if (this.rank[i] >= frac) { f.hide(i); continue; }
      const o = i * 7;
      const s0 = this.seed[o], s1 = this.seed[o + 1], s2 = this.seed[o + 2], s3 = this.seed[o + 3], s4 = this.seed[o + 4], s5 = this.seed[o + 5];
      let x = 0, y = 0, z = 0, al = 1, ph = 0;
      switch (st.mode) {
        case 'rise':
        case 'fall': {
          ph = (t * rate * (0.8 + 0.4 * s1) + s0) % 1;
          const ang = s2 * TAU + ph * st.turns * TAU;
          const r = RAD * (0.35 + 0.65 * s3) * (1 - 0.25 * ph);
          const yy = ph * H * (0.75 + 0.25 * s4);
          y = st.mode === 'rise' ? 0.05 + yy : H - yy;
          x = Math.cos(ang) * r + (st.mode === 'fall' ? Math.sin(t * 1.7 + s5 * 30) * 0.05 : 0);
          z = Math.sin(ang) * r;
          al = smooth(0, 0.12, ph) * (1 - smooth(0.68, 1, ph));
          break;
        }
        case 'swirl': {
          ph = (t * rate * 0.22 + s0) % 1;
          const ang = s2 * TAU + t * rate * (s5 > 0.5 ? 1.6 : -1.3) * st.turns;
          const r = RAD * (0.55 + 0.45 * s3);
          y = 0.1 + ph * (H - 0.2);
          x = Math.cos(ang) * r;
          z = Math.sin(ang) * r;
          al = smooth(0, 0.15, ph) * (1 - smooth(0.75, 1, ph));
          break;
        }
        case 'inward': {
          ph = (t * rate * (0.8 + 0.4 * s1) + s0) % 1;
          const r = RAD * 1.15 * Math.pow(1 - ph, 1.2) + 0.05;
          const ang = s2 * TAU + ph * ph * 7 * st.turns;
          y = (0.1 + s4 * 1.5) * (1 - ph * 0.7) + 0.05;
          x = Math.cos(ang) * r;
          z = Math.sin(ang) * r;
          al = smooth(0, 0.12, ph) * (1 - smooth(0.85, 1, ph));
          break;
        }
        default: {
          // wander: lazy Lissajous loops around the body, blinking.
          const a = t * (0.35 + 0.3 * s1) + s0 * TAU;
          x = Math.sin(a) * RAD * (0.5 + 0.5 * s3);
          z = Math.cos(a * 0.83 + s2 * 6) * RAD * (0.5 + 0.5 * s3);
          y = 0.3 + H * 0.8 * (0.5 + 0.5 * Math.sin(t * 0.5 * (1 + s4) + s5 * TAU));
          const cyc = (t * (0.4 + 0.2 * s1) + s4) % 1;
          al = cyc < 0.65 ? Math.pow(Math.sin((cyc / 0.65) * Math.PI), 1.1) : 0.05;
          ph = s0;
        }
      }
      al *= env;
      if (al <= 0.003) { f.hide(i); continue; }
      let r: number, g: number, b: number;
      if (st.hue) {
        const c = hsv((s0 + t * 0.2 + ph * 0.5) % 1, 0.55, 1.35);
        r = c[0]; g = c[1]; b = c[2];
      } else {
        const k = st.mode === 'wander' ? 0 : ph;
        r = mix(st.hot[0], st.cool[0], k); g = mix(st.hot[1], st.cool[1], k); b = mix(st.hot[2], st.cool[2], k);
      }
      const cell = st.bits ? (hash(Math.floor(t * 3 + s0 * 10) + i * 7.1) > 0.5 ? CELL.one : CELL.zero) : st.cell;
      let size = st.size * (0.7 + 0.6 * s5);
      if (st.cell === CELL.flame || st.cell === CELL.heart) size *= 0.7 + 0.5 * smooth(0, 0.3, ph) * (1 - 0.4 * ph);
      const flick = calm ? 1 : 0.85 + 0.15 * Math.sin(t * 29 + s1 * 50);
      const rot = st.spin ? t * st.spin + s2 * 6 : 0;
      f.put(i, ox + x, oy + y, oz + z, r * flick, g * flick, b * flick, al * (calm ? 0.8 : 1), size, cell, rot);
    }
    f.commit();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.f.dispose();
    this.rib.dispose();
  }
}
