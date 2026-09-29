import * as THREE from 'three';
import { fxFlags } from './fx-settings';
import { lightningPath, RibbonBatch } from './ribbon';
import { CELL, unusualAtlas } from './unusual-atlas';
import { Field, TAU, hash, hsv, mix, rnd, smooth, tmpVp, views, type SharedUniforms } from './unusual-core';

// ── Professional killstreak eyes ─────────────────────────────────────────────
// TF2's "Professional Killstreak" eye effects, on the combatant's visor: while
// the wearer is on a streak (≥ 5) small wisps / flames / vortices come off the
// two eye slits — subtle, sub-decimetre, always outside the wearer's own view:
//
//   const eyes = new KillstreakEyes();
//   character.sockets.headTop.add(eyes.group);   // rides the head bone
//   eyes.setEffect('ks.tornado');                // KS_EFFECTS id (null = none)
//   eyes.setStreak(streak);                      // ≥ 5 shows; intensity rises to 15
//   eyes.setFirstPerson(isLocalPlayer);          // your own camera: nothing is drawn
//   eyes.update(dt);                             // every frame
//
// The recipes are analytic (no per-frame allocation, frame-rate independent):
// each of N particles owns a phase and is placed from the head's world matrix
// every frame, so the effect turns with the head. reducedEffects: no flicker,
// no bolts, slower; lowSpec: half the particles.

export type KsEffectId = 'ks.fire' | 'ks.cerebral' | 'ks.tornado' | 'ks.flames' | 'ks.singularity' | 'ks.incinerator' | 'ks.hypno';

const N = 32; // 16 per eye
const PER = N / 2;
export const KS_MIN_STREAK = 5;

// Head-socket frame (child of `headTop`): the visor's front is +Z. Eye slits
// sit ±EX to the sides, EY below the crown, just proud of the visor at EZ.
const EX = 0.052;
const EY = -0.141;
const EZ = 0.158;

const KNOWN: readonly string[] = ['ks.fire', 'ks.cerebral', 'ks.tornado', 'ks.flames', 'ks.singularity', 'ks.incinerator', 'ks.hypno'];

export class KillstreakEyes {
  readonly group = new THREE.Group();
  private readonly f: Field;
  private readonly rib: RibbonBatch;
  private readonly u: SharedUniforms & Record<string, THREE.IUniform>;
  private effect: KsEffectId | null = null;
  private streak = 0;
  private fp = false;
  private env = 0;
  private t = 0;
  private ppm = 200;
  private readonly arcPath = new Float32Array(3 * 9 * 3);
  private readonly arcT = new Float32Array(3);
  private readonly arcF = new Float32Array(3);
  private readonly arcPathV = views(this.arcPath, 27);
  private readonly seed = new Float32Array(N * 3);
  // Last local → world transform target.
  private wx = 0;
  private wy = 0;
  private wz = 0;

  constructor() {
    this.group.name = 'ks-eyes';
    this.group.visible = false;
    this.u = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as SharedUniforms & Record<string, THREE.IUniform>;
    this.u.uAtlas = { value: unusualAtlas() };
    this.u.uViewH = { value: 900 };
    this.u.uMinPx = { value: 1.5 };
    this.u.uGain = { value: 1 };
    this.u.uHdrCap = { value: 1.6 };
    this.u.uMinLum = { value: 0 };
    this.u.uOcclude = { value: 0.3 };
    this.u.uNear = { value: 0 };
    this.f = new Field(N, this.u, true);
    this.f.setBounds(0, 0, 0, 1);
    this.rib = new RibbonBatch(3, 9, 1.4);
    this.rib.mesh.matrixAutoUpdate = false;
    this.rib.mesh.matrixWorldAutoUpdate = false;
    this.group.add(this.f.points, this.rib.mesh);
    for (let i = 0; i < N * 3; i++) this.seed[i] = hash(i * 3.17 + 1.3);
    this.f.points.onBeforeRender = (renderer, _s, camera) => {
      renderer.getCurrentViewport(tmpVp);
      const vh = Math.max(1, tmpVp.w);
      const ce = camera.matrixWorld.elements;
      const e = this.group.matrixWorld.elements;
      const d = Math.max(0.3, Math.hypot(ce[12] - e[12], ce[13] - e[13], ce[14] - e[14]));
      const p11 = (camera as THREE.PerspectiveCamera).projectionMatrix.elements[5];
      const ppm = (p11 * vh * 0.5) / d;
      this.ppm = ppm;
      this.u.uViewH.value = vh;
      // Subtle: stay under the bloom threshold up close, dimmer with range.
      this.u.uGain.value = 1.0 + 0.4 * smooth(10, 70, ppm);
      this.u.uHdrCap.value = 1.5 + 0.7 * smooth(10, 80, ppm);
      this.u.uMinLum.value = 1.0 * (1 - smooth(20, 80, ppm));
      this.f.mat.uniformsNeedUpdate = true;
    };
    this.group.traverse((o) => {
      o.userData.shared = true;
    });
  }

  // A KS_EFFECTS id (items/types.ts); null / unknown = no effect.
  setEffect(id: string | null | undefined): void {
    this.effect = id && KNOWN.includes(id) ? (id as KsEffectId) : null;
  }

  // Current killstreak: ≥ 5 shows the effect, brighter toward 15.
  setStreak(n: number): void {
    this.streak = Number.isFinite(n) ? n : 0;
  }

  // The local player's own camera never sees their own eyes (nothing is drawn).
  setFirstPerson(on: boolean): void {
    this.fp = on;
  }

  get active(): boolean {
    return !!this.effect && this.streak >= KS_MIN_STREAK && !this.fp;
  }

  private lw(x: number, y: number, z: number) {
    const e = this.group.matrixWorld.elements;
    this.wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    this.wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    this.wz = e[2] * x + e[6] * y + e[10] * z + e[14];
  }

  update(dt: number): void {
    dt = Math.max(0, Math.min(dt, 0.1));
    const on = this.active;
    this.env += ((on ? 1 : 0) - this.env) * (1 - Math.exp(-(on ? 7 : 5) * dt));
    if (!on && this.env < 0.004) {
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
    const t = this.t;
    this.group.updateWorldMatrix(true, false);
    const e = this.group.matrixWorld.elements;
    this.f.setBounds(e[12], e[13], e[14], 0.6);
    const k = this.env * (0.6 + 0.4 * smooth(KS_MIN_STREAK, 15, this.streak));
    const fx = this.effect!;
    // Far away the effect is a smear: thin it out.
    const per = Math.max(4, Math.round(PER * (fxFlags.low ? 0.5 : 1) * (this.ppm > 12 ? 1 : 0.6)));
    const f = this.f;
    const rib = this.rib;
    rib.begin();
    // Cerebral Discharge: two temple arcs and a bridge across the brow.
    if (fx === 'ks.cerebral' && !calm) {
      for (let a = 0; a < 3; a++) {
        this.arcT[a] -= dt;
        if (this.arcT[a] <= 0) {
          this.arcT[a] = 0.04 + rnd() * 0.06;
          this.arcF[a] = rnd() < 0.35 ? 0 : 0.7 + rnd() * 0.3;
          const P = this.arcPathV[a];
          if (a < 2) {
            const sx = a === 0 ? -1 : 1;
            lightningPath(P, 9, sx * EX, EY + 0.012, EZ, sx * (0.115 + rnd() * 0.03), EY + 0.1 + rnd() * 0.05, EZ - 0.04, 0.012);
          } else lightningPath(P, 9, -EX, EY + 0.03, EZ + 0.005, EX, EY + 0.03, EZ + 0.005, 0.01);
        }
        const fl = this.arcF[a] * k;
        if (fl <= 0) continue;
        for (let j = 0; j < 9; j++) {
          this.lw(this.arcPath[a * 27 + j * 3], this.arcPath[a * 27 + j * 3 + 1], this.arcPath[a * 27 + j * 3 + 2]);
          rib.push(a, this.wx, this.wy, this.wz, 0.6 * 1.6 * fl, 1.1 * 1.6 * fl, 2.0 * 1.6 * fl, 0.006);
        }
      }
    }
    rib.commit();
    for (let i = 0; i < N; i++) {
      const eye = i % 2;
      const j = (i - eye) / 2;
      if (j >= per) { f.hide(i); continue; }
      const sx = eye === 0 ? -1 : 1;
      const s0 = this.seed[i * 3], s1 = this.seed[i * 3 + 1], s2 = this.seed[i * 3 + 2];
      let x = 0, y = 0, z = 0;
      let r = 1, g = 1, b = 1, al = 0, size = 0.03, cell: number = CELL.glow, rot = 0;
      const jf = j / PER;
      switch (fx) {
        case 'ks.fire': {
          // Horns: flame plumes curl up and outward off the brow corners.
          const ph = (t * 0.9 + s0) % 1;
          x = sx * (0.07 + 0.11 * Math.pow(ph, 1.4));
          y = EY + 0.06 + 0.22 * ph;
          z = EZ - 0.06 + 0.03 * Math.sin(t * 6 + s1 * 20) * ph;
          const flame = j % 2 === 0;
          const fr = ph;
          r = mix(2.0, 0.7, fr); g = mix(1.0, 0.1, fr); b = mix(0.25, 0.0, fr);
          al = smooth(0, 0.15, ph) * Math.pow(1 - ph, 1.2) * 0.85;
          size = flame ? mix(0.085, 0.03, ph) : mix(0.05, 0.02, ph);
          cell = flame ? CELL.flame : CELL.glow;
          rot = sx * -0.25 * ph;
          break;
        }
        case 'ks.flames':
        case 'ks.incinerator': {
          const hot = fx === 'ks.incinerator';
          const ph = (t * (hot ? 1.5 : 1.1) + s0) % 1;
          x = sx * EX + (s1 - 0.5) * 0.02 + Math.sin(t * 9 + s2 * 30) * 0.008 * ph;
          y = EY + 0.02 + ph * (hot ? 0.19 : 0.12);
          z = EZ + 0.02 + ph * (hot ? 0.06 : 0.04);
          if (hot) {
            r = mix(2.4, 1.0, ph); g = mix(1.9, 0.3, ph); b = mix(1.4, 0.05, ph);
          } else {
            r = mix(2.0, 0.6, ph); g = mix(0.9, 0.1, ph); b = mix(0.2, 0.0, ph);
          }
          al = smooth(0, 0.1, ph) * Math.pow(1 - ph, 1.3) * 0.85;
          const tongue = j % 3 !== 0;
          size = (tongue ? mix(0.08, 0.03, ph) : mix(0.045, 0.02, ph)) * (hot ? 1.3 : 1);
          cell = tongue ? CELL.flame : CELL.glow;
          if (hot && j % 4 === 3) { cell = CELL.dot; size = 0.014; y += ph * 0.12; x += sx * ph * 0.05; g *= 1.3; b *= 1.2; }
          break;
        }
        case 'ks.tornado': {
          // A tiny spinning funnel over each eye, widening as it rises.
          const ph = (t * 0.8 + jf) % 1;
          const rr = 0.008 + 0.05 * ph;
          const ang = s0 * TAU + t * 9 * -sx + ph * 5;
          x = sx * EX + Math.cos(ang) * rr;
          y = EY + 0.01 + ph * 0.17;
          z = EZ + 0.03 + Math.sin(ang) * rr * 0.9;
          const v = 0.8;
          r = 0.85 * v; g = 0.95 * v; b = 1.15 * v;
          al = smooth(0, 0.15, ph) * (1 - smooth(0.6, 1, ph)) * 0.75;
          size = mix(0.018, 0.04, ph);
          cell = ph < 0.5 ? CELL.dot : CELL.wisp;
          rot = ang;
          break;
        }
        case 'ks.singularity': {
          // A miniature black hole: a fast ring of light, a violet core glow.
          const a = jf * TAU + t * 7 * sx + s0 * 0.4;
          const rr = 0.032 * (1 + 0.15 * Math.sin(t * 3 + s1 * 6));
          if (j === 0) {
            x = sx * EX; y = EY; z = EZ + 0.015;
            r = 0.5; g = 0.15; b = 1.0; al = 0.85; size = 0.075; cell = CELL.glow;
          } else {
            x = sx * EX + Math.cos(a) * rr;
            y = EY + Math.sin(a) * rr * 0.8;
            z = EZ + 0.02 + Math.cos(a * 2) * 0.006;
            const hi = 0.5 + 0.5 * Math.sin(a * 2 - t * 5);
            r = mix(0.8, 1.9, hi); g = mix(0.3, 1.2, hi); b = mix(1.5, 2.3, hi);
            al = 0.9;
            size = 0.017;
            cell = CELL.dot;
          }
          // Inward-drifting dust.
          if (j > PER - 4) {
            const ph = (t * 0.9 + s2) % 1;
            const r2 = 0.09 * (1 - ph);
            const a2 = s0 * TAU + ph * 5 * sx;
            x = sx * EX + Math.cos(a2) * r2;
            y = EY + Math.sin(a2) * r2 * 0.8;
            z = EZ + 0.02;
            r = 1.2; g = 0.5; b = 1.9; al = smooth(0, 0.2, ph) * (1 - smooth(0.85, 1, ph)) * 0.8;
            size = 0.014; cell = CELL.dot;
          }
          break;
        }
        case 'ks.cerebral': {
          // Sparks popping around the temples (the arcs are ribbons).
          const cyc = (t * (0.9 + s1) + s0) % 1;
          x = sx * (0.06 + 0.07 * s2);
          y = EY + 0.03 + 0.09 * hash(j * 1.7 + eye * 5);
          z = EZ + 0.03 * s1;
          const tw = cyc < 0.25 ? Math.pow(Math.sin((cyc / 0.25) * Math.PI), 2) : 0;
          if (j >= 4) { al = 0; break; }
          r = 1.2; g = 1.9; b = 2.4; al = tw * 0.9; size = 0.02 + 0.03 * tw; cell = tw > 0.5 ? CELL.star : CELL.dot;
          rot = t * 3 + s0 * 6;
          // Soft blue glow at the eye itself.
          if (j === 0) { x = sx * EX; y = EY; z = EZ + 0.01; r = 0.2; g = 0.55; b = 1.2; al = 0.7 + 0.2 * Math.sin(t * 9 + eye); size = 0.05; cell = CELL.glow; rot = 0; }
          break;
        }
        default: {
          // Hypno-Beam: rings expanding off each eye, alternating hue, and a
          // turning spiral of dots.
          if (j < 3) {
            const ph = (t * 0.85 + j / 3) % 1;
            x = sx * EX; y = EY; z = EZ + 0.02;
            const c = hsv((eye * 0.5 + 0.85 + ph * 0.3 + t * 0.1) % 1, 0.8, 1.3);
            r = c[0]; g = c[1]; b = c[2];
            al = smooth(0, 0.1, ph) * (1 - ph) * 0.9;
            size = 0.02 + 0.11 * ph;
            cell = CELL.ring;
          } else {
            const kk = (j - 3) / (PER - 3);
            const a = kk * 9 + t * 8 * sx;
            const rr = 0.006 + 0.034 * kk;
            x = sx * EX + Math.cos(a) * rr;
            y = EY + Math.sin(a) * rr * 0.85;
            z = EZ + 0.02;
            const c = hsv((0.85 + kk * 0.4 + eye * 0.5) % 1, 0.6, 1.9);
            r = c[0]; g = c[1]; b = c[2];
            al = 0.9;
            size = 0.014;
            cell = CELL.dot;
          }
        }
      }
      if (al * k <= 0.003) { f.hide(i); continue; }
      this.lw(x, y, z);
      const flick = calm ? 1 : 0.88 + 0.12 * Math.sin(t * 31 + s1 * 50);
      f.put(i, this.wx, this.wy, this.wz, r * flick, g * flick, b * flick, Math.min(1, al * k * 1.25), size * 1.5, cell, rot);
    }
    f.commit();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.f.dispose();
    this.rib.dispose();
  }
}
