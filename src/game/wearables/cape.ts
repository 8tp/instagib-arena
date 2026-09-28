import * as THREE from 'three';
import type { Surf, V3 } from './kit';
import type { CapeSpec } from './spec';

// ── Spring-simulated cape ────────────────────────────────────────────────────
// A small Verlet cloth (6×7 nodes; 4×5 on low spec) simulated in WORLD space:
// the collar row is pinned to the back socket, the rest swings under gravity,
// air drag (relative to the wearer's motion, so it billows when you run or
// dash) and a little speed-scaled flutter. It collides with the wearer's back
// (analytic, in the chest frame) and with spheres on the legs. Fixed ≤1/60 s
// sub-steps → frame-rate independent. No per-frame allocation.
//
// Rendering is a finer grid (bilinear over the nodes) with pleats and crisp
// colour bands (duplicated rows/columns at band edges → zero-area seams), in
// the socket's local frame so the mesh rides the body with no follow code.

const GRAV = -9.8;
const MAX_STEP = 1 / 60;
const DRAG = 1.15; // air drag (1/s)
const DAMP60 = 0.988; // velocity kept per 1/60 s
const PLEATS = 3;
const PLEAT_AMP = 0.011;

export type Wind = { x: number; y: number; z: number };

const _v = new THREE.Vector3();

export class CapeSim {
  readonly mesh: THREE.Mesh;
  private readonly C: number;
  private readonly R: number;
  private readonly N: number;
  private readonly restL: Float32Array; // socket-local rest positions
  private readonly pos: Float32Array; // world
  private readonly prev: Float32Array;
  private readonly pinPrev: Float32Array; // pinned row, world, last update
  private readonly pinNow: Float32Array;
  private readonly lenH: Float32Array;
  private readonly lenV: Float32Array;
  private readonly nrm: Float32Array; // world normals per node
  private readonly ru: Float32Array; // render column u
  private readonly rv: Float32Array; // render row v
  private readonly posAttr: THREE.BufferAttribute;
  private readonly inv = new THREE.Matrix4();
  private readonly W = new THREE.Matrix4();
  private reset = true;
  private t = 0;
  private readonly origin: V3;
  private readonly topY: number;

  constructor(spec: CapeSpec, origin: V3, low: boolean, material: THREE.Material) {
    this.origin = origin;
    this.topY = spec.top[1];
    const C = (this.C = low ? 4 : 6);
    const R = (this.R = low ? 5 : 7);
    const N = (this.N = C * R);
    this.restL = new Float32Array(N * 3);
    for (let j = 0; j < R; j++) {
      const v = j / (R - 1);
      const w = spec.width + (spec.hemWidth - spec.width) * Math.pow(v, 0.8);
      for (let i = 0; i < C; i++) {
        const u = i / (C - 1);
        const x = (u - 0.5) * w;
        const y = spec.top[1] - spec.length * v;
        const z = spec.top[2] + 0.034 * Math.min(1, v * 5) - 1.3 * x * x * (1 - v);
        const k = (j * C + i) * 3;
        this.restL[k] = x - origin[0];
        this.restL[k + 1] = y - origin[1];
        this.restL[k + 2] = z - origin[2];
      }
    }
    this.pos = new Float32Array(N * 3);
    this.prev = new Float32Array(N * 3);
    this.nrm = new Float32Array(N * 3);
    this.pinPrev = new Float32Array(C * 3);
    this.pinNow = new Float32Array(C * 3);
    this.lenH = new Float32Array(R * (C - 1));
    this.lenV = new Float32Array((R - 1) * C);
    const d = (a: number, b: number) =>
      Math.hypot(this.restL[a * 3] - this.restL[b * 3], this.restL[a * 3 + 1] - this.restL[b * 3 + 1], this.restL[a * 3 + 2] - this.restL[b * 3 + 2]);
    for (let j = 0; j < R; j++) for (let i = 0; i < C - 1; i++) this.lenH[j * (C - 1) + i] = d(j * C + i, j * C + i + 1);
    for (let j = 0; j < R - 1; j++) for (let i = 0; i < C; i++) this.lenV[j * C + i] = d(j * C + i, (j + 1) * C + i);

    // ── Render grid: columns/rows with duplicates at colour edges ──
    const cols: { u: number; edge: boolean }[] = [];
    const RC = low ? 7 : 13;
    const ew = spec.edge?.w ?? 0;
    for (let c = 0; c < RC; c++) {
      const u = c / (RC - 1);
      cols.push({ u, edge: ew > 0 && (u < ew || u > 1 - ew) });
    }
    if (ew > 0) {
      for (const b of [ew, 1 - ew]) {
        cols.push({ u: b, edge: true }, { u: b, edge: false });
      }
      cols.sort((a, b) => a.u - b.u || (a.u < 0.5 ? (a.edge ? -1 : 1) : a.edge ? 1 : -1));
    }
    const bands = spec.bands;
    const bandAt = (v: number) => {
      let s = bands[0][1];
      for (const [bv, bs] of bands) if (v >= bv) s = bs;
      return s;
    };
    const rows: { v: number; s: Surf }[] = [];
    const RR = low ? 6 : 10;
    for (let r = 0; r < RR; r++) {
      const v = r / (RR - 1);
      rows.push({ v, s: bandAt(v + 1e-6) });
    }
    for (let b = 1; b < bands.length; b++) {
      const bv = bands[b][0];
      rows.push({ v: bv, s: bands[b - 1][1] }, { v: bv, s: bands[b][1] });
    }
    rows.sort((a, b) => a.v - b.v || bands.findIndex((x) => x[1] === a.s) - bands.findIndex((x) => x[1] === b.s));
    const nc = cols.length;
    const nr = rows.length;
    this.ru = new Float32Array(cols.map((c) => c.u));
    this.rv = new Float32Array(rows.map((r) => r.v));
    const nv = nc * nr;
    const position = new Float32Array(nv * 3);
    const color = new Float32Array(nv * 3);
    const mat = new Float32Array(nv * 4);
    const col = new THREE.Color();
    for (let r = 0; r < nr; r++) {
      for (let c = 0; c < nc; c++) {
        const s = cols[c].edge && spec.edge ? spec.edge.s : rows[r].s;
        const o = r * nc + c;
        col.setHex(s.c);
        color[o * 3] = col.r;
        color[o * 3 + 1] = col.g;
        color[o * 3 + 2] = col.b;
        mat[o * 4] = (s.t ?? 0) + 4 * (s.fx ?? 0);
        mat[o * 4 + 1] = s.r;
        mat[o * 4 + 2] = s.m;
        mat[o * 4 + 3] = s.e ?? 0;
      }
    }
    const index: number[] = [];
    for (let r = 0; r < nr - 1; r++) {
      if (rows[r + 1].v - rows[r].v < 1e-6) continue; // colour seam
      for (let c = 0; c < nc - 1; c++) {
        if (cols[c + 1].u - cols[c].u < 1e-6) continue;
        const a = r * nc + c;
        const b = a + 1;
        const d2 = a + nc;
        const e = d2 + 1;
        index.push(a, d2, e, a, e, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(position, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
    geo.setIndex(index);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -0.35, 0.15), 1.3);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'cape';
    this.mesh.castShadow = true;
    this.mesh.userData.shared = true; // freed by dispose(), not Game.disposeScene()
    this.writeRest();
  }

  // Show the rest shape (before the first update / when not simulated).
  private writeRest(): void {
    const { C, R } = this;
    const a = this.posAttr.array as Float32Array;
    const nc = this.ru.length;
    for (let r = 0; r < this.rv.length; r++) {
      for (let c = 0; c < nc; c++) {
        const fu = this.ru[c] * (C - 1);
        const fv = this.rv[r] * (R - 1);
        const i0 = Math.min(C - 2, Math.floor(fu));
        const j0 = Math.min(R - 2, Math.floor(fv));
        const tu = fu - i0;
        const tv = fv - j0;
        const o = (r * nc + c) * 3;
        for (let k = 0; k < 3; k++) {
          const p00 = this.restL[(j0 * C + i0) * 3 + k];
          const p10 = this.restL[(j0 * C + i0 + 1) * 3 + k];
          const p01 = this.restL[((j0 + 1) * C + i0) * 3 + k];
          const p11 = this.restL[((j0 + 1) * C + i0 + 1) * 3 + k];
          a[o + k] = (p00 * (1 - tu) + p10 * tu) * (1 - tv) + (p01 * (1 - tu) + p11 * tu) * tv;
        }
      }
    }
    this.posAttr.needsUpdate = true;
  }

  // Mark for a snap back to rest on the next active update (respawn, teleport).
  invalidate(): void {
    this.reset = true;
  }

  // `socket` = the back socket (world matrix must be current). `spheres` are
  // world-space leg colliders (x, y, z, r) × `nSph`. `active` false = frozen
  // (hidden / gibbed): skip the sim and reset on the next active frame.
  update(dt: number, socket: THREE.Object3D, wind: Wind, spheres: Float32Array, nSph: number, active: boolean): void {
    if (!active) {
      this.reset = true;
      return;
    }
    const { C, R, N, pos, prev, restL } = this;
    const W = this.W.copy(socket.matrixWorld);
    this.inv.copy(W).invert();
    // Pinned row at the current socket pose.
    for (let i = 0; i < C; i++) {
      _v.set(restL[i * 3], restL[i * 3 + 1], restL[i * 3 + 2]).applyMatrix4(W);
      this.pinNow[i * 3] = _v.x;
      this.pinNow[i * 3 + 1] = _v.y;
      this.pinNow[i * 3 + 2] = _v.z;
    }
    if (!this.reset) {
      const dx = this.pinNow[0] - this.pinPrev[0];
      const dy = this.pinNow[1] - this.pinPrev[1];
      const dz = this.pinNow[2] - this.pinPrev[2];
      if (dx * dx + dy * dy + dz * dz > 2.25) this.reset = true; // teleport (> 1.5 m)
    }
    if (this.reset) {
      this.reset = false;
      for (let n = 0; n < N; n++) {
        _v.set(restL[n * 3], restL[n * 3 + 1], restL[n * 3 + 2]).applyMatrix4(W);
        pos[n * 3] = prev[n * 3] = _v.x;
        pos[n * 3 + 1] = prev[n * 3 + 1] = _v.y;
        pos[n * 3 + 2] = prev[n * 3 + 2] = _v.z;
      }
      this.pinPrev.set(this.pinNow);
    }
    dt = Math.min(Math.max(dt, 0), 0.1);
    if (dt > 0) {
      const steps = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-6));
      const h = dt / steps;
      const damp = Math.pow(DAMP60, h * 60);
      const iters = C > 4 ? 3 : 2;
      for (let s = 1; s <= steps; s++) {
        this.t += h;
        const f = s / steps;
        // Integrate (row 0 is pinned).
        for (let n = C; n < N; n++) {
          const k = n * 3;
          const vx = (pos[k] - prev[k]) * damp;
          const vy = (pos[k + 1] - prev[k + 1]) * damp;
          const vz = (pos[k + 2] - prev[k + 2]) * damp;
          prev[k] = pos[k];
          prev[k + 1] = pos[k + 1];
          prev[k + 2] = pos[k + 2];
          // Air-relative velocity (m/s) → drag + speed-scaled flutter.
          const rx = vx / h + wind.x;
          const ry = vy / h + wind.y;
          const rz = vz / h + wind.z;
          const sp = Math.sqrt(rx * rx + ry * ry + rz * rz);
          const row = Math.floor(n / C);
          const fl = Math.min(sp, 14) * 0.55 * (row / (R - 1)) * Math.sin(this.t * 11 + (n % C) * 1.9 + row * 2.7);
          const ax = -DRAG * rx + fl * 0.5;
          const ay = GRAV - DRAG * ry + fl;
          const az = -DRAG * rz;
          pos[k] += vx + ax * h * h;
          pos[k + 1] += vy + ay * h * h;
          pos[k + 2] += vz + az * h * h;
        }
        // Pins (interpolated across sub-steps).
        for (let i = 0; i < C; i++) {
          const k = i * 3;
          pos[k] = prev[k] = this.pinPrev[k] + (this.pinNow[k] - this.pinPrev[k]) * f;
          pos[k + 1] = prev[k + 1] = this.pinPrev[k + 1] + (this.pinNow[k + 1] - this.pinPrev[k + 1]) * f;
          pos[k + 2] = prev[k + 2] = this.pinPrev[k + 2] + (this.pinNow[k + 2] - this.pinPrev[k + 2]) * f;
        }
        for (let it = 0; it < iters; it++) {
          for (let j = 0; j < R; j++) for (let i = 0; i < C - 1; i++) this.link(j * C + i, j * C + i + 1, this.lenH[j * (C - 1) + i], j === 0);
          for (let j = 0; j < R - 1; j++) for (let i = 0; i < C; i++) this.link(j * C + i, (j + 1) * C + i, this.lenV[j * C + i], false, j === 0);
          this.collide(spheres, nSph);
        }
      }
    }
    this.pinPrev.set(this.pinNow);
    this.writeRender();
  }

  // Distance constraint (a pinned end doesn't move).
  private link(a: number, b: number, L: number, bothPinned: boolean, aPinned = false): void {
    if (bothPinned) return;
    const p = this.pos;
    const ka = a * 3;
    const kb = b * 3;
    const dx = p[kb] - p[ka];
    const dy = p[kb + 1] - p[ka + 1];
    const dz = p[kb + 2] - p[ka + 2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
    const diff = (d - L) / d;
    if (aPinned) {
      p[kb] -= dx * diff;
      p[kb + 1] -= dy * diff;
      p[kb + 2] -= dz * diff;
      return;
    }
    const h = diff * 0.5;
    p[ka] += dx * h;
    p[ka + 1] += dy * h;
    p[ka + 2] += dz * h;
    p[kb] -= dx * h;
    p[kb + 1] -= dy * h;
    p[kb + 2] -= dz * h;
  }

  // Keep the cloth off the back (chest frame) and out of the leg spheres.
  private collide(spheres: Float32Array, nSph: number): void {
    const { C, N, pos } = this;
    const e = this.inv.elements;
    const w = this.W.elements;
    const ox = this.origin[0];
    const oy = this.origin[1];
    const oz = this.origin[2];
    for (let n = C; n < N; n++) {
      const k = n * 3;
      let x = pos[k];
      let y = pos[k + 1];
      let z = pos[k + 2];
      // World → chest-local (model-rest coordinates).
      const lx = e[0] * x + e[4] * y + e[8] * z + e[12] + ox;
      const ly = e[1] * x + e[5] * y + e[9] * z + e[13] + oy;
      let lz = e[2] * x + e[6] * y + e[10] * z + e[14] + oz;
      const ax = Math.abs(lx);
      let zb: number;
      if (ly > this.topY + 0.01) zb = 0.15;
      else if (ly > 1.2) {
        const t = Math.min(1, Math.max(0, (ax - 0.075) / 0.05));
        zb = 0.215 - 0.07 * t;
      } else if (ly > 0.9) zb = 0.18;
      else zb = 0.1;
      if (lz < zb && ax < 0.3) {
        lz = zb;
        const mx = lx - ox;
        const my = ly - oy;
        const mz = lz - oz;
        x = w[0] * mx + w[4] * my + w[8] * mz + w[12];
        y = w[1] * mx + w[5] * my + w[9] * mz + w[13];
        z = w[2] * mx + w[6] * my + w[10] * mz + w[14];
      }
      for (let s = 0; s < nSph; s++) {
        const q = s * 4;
        const dx = x - spheres[q];
        const dy = y - spheres[q + 1];
        const dz = z - spheres[q + 2];
        const r = spheres[q + 3];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < r * r && d2 > 1e-10) {
          const f = r / Math.sqrt(d2);
          x = spheres[q] + dx * f;
          y = spheres[q + 1] + dy * f;
          z = spheres[q + 2] + dz * f;
        }
      }
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;
    }
  }

  private writeRender(): void {
    const { C, R, pos, nrm } = this;
    // Node normals (world).
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < C; i++) {
        const l = j * C + Math.max(0, i - 1);
        const r = j * C + Math.min(C - 1, i + 1);
        const u = Math.max(0, j - 1) * C + i;
        const d = Math.min(R - 1, j + 1) * C + i;
        const ax = pos[r * 3] - pos[l * 3];
        const ay = pos[r * 3 + 1] - pos[l * 3 + 1];
        const az = pos[r * 3 + 2] - pos[l * 3 + 2];
        const bx = pos[d * 3] - pos[u * 3];
        const by = pos[d * 3 + 1] - pos[u * 3 + 1];
        const bz = pos[d * 3 + 2] - pos[u * 3 + 2];
        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        const o = (j * C + i) * 3;
        nrm[o] = nx;
        nrm[o + 1] = ny;
        nrm[o + 2] = nz;
      }
    }
    const e = this.inv.elements;
    const a = this.posAttr.array as Float32Array;
    const nc = this.ru.length;
    for (let r = 0; r < this.rv.length; r++) {
      const v = this.rv[r];
      const fv = v * (R - 1);
      const j0 = Math.min(R - 2, Math.floor(fv));
      const tv = fv - j0;
      for (let c = 0; c < nc; c++) {
        const u = this.ru[c];
        const fu = u * (C - 1);
        const i0 = Math.min(C - 2, Math.floor(fu));
        const tu = fu - i0;
        const n00 = (j0 * C + i0) * 3;
        const n10 = n00 + 3;
        const n01 = n00 + C * 3;
        const n11 = n01 + 3;
        const w00 = (1 - tu) * (1 - tv);
        const w10 = tu * (1 - tv);
        const w01 = (1 - tu) * tv;
        const w11 = tu * tv;
        const pleat = PLEAT_AMP * Math.cos(u * Math.PI * 2 * PLEATS) * Math.pow(v, 0.7);
        const o = (r * nc + c) * 3;
        let x = 0;
        let y = 0;
        let z = 0;
        for (let q = 0; q < 3; q++) {
          const p = pos[n00 + q] * w00 + pos[n10 + q] * w10 + pos[n01 + q] * w01 + pos[n11 + q] * w11;
          const nn = nrm[n00 + q] * w00 + nrm[n10 + q] * w10 + nrm[n01 + q] * w01 + nrm[n11 + q] * w11;
          const val = p + nn * pleat;
          if (q === 0) x = val;
          else if (q === 1) y = val;
          else z = val;
        }
        a[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
        a[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        a[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
    }
    this.posAttr.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
