import { BONE_INDEX, type BoneName } from './rig';
import { PoseSpec, SIDE_L, SIDE_R } from './pose';

// ── Keyframe clip DSL ────────────────────────────────────────────────────────
//
// A clip is a list of sparse keys. Each key sets any subset of channels; every
// channel is interpolated independently between the keys that mention it, so
// you only key what moves. Angles are DEGREES here (converted on compile).
//
//   r:    { head: [x, y, z], chest: [...], 'hand.R': [...] }  euler YXZ
//   hips: [x, y, z]   hips translation offset (m)
//   root: [x, y, z, yawDeg]   whole-body offset + spin
//   hL/hR: wrist targets in rest-model coords (they ride the chest)
//   eL/eR: elbow pole directions (chest frame)
//   fL/fR: ankle targets in ground space (y = 0.095 is planted)
//   kL/kR: knee pole directions (hips frame)
//   e:    easing INTO this key from the previous key of each channel
//
// Oscillators add a sine on any channel component for secondary motion
// (bobs, wiggles) — `cycles` per loop keeps looping clips seamless.
//
// Props: a clip may carry small hard-light props (built by emote-props.ts —
// an "L" glyph, a sign, a mic…). Each rides one bone of the combatant, is
// keyed in that bone's frame (p: metres, r: degrees YXZ, s: uniform scale)
// with the same easing, and only shows inside its [from, to] window while
// the clip's blend weight is above ½ (CharacterAnimator owns them).

export type Ease = 'linear' | 'in' | 'out' | 'inOut' | 'outBack' | 'inBack' | 'outElastic' | 'hold';
type V = readonly number[];
type RBone = BoneName;

export type KeyDef = {
  t: number;
  e?: Ease;
  r?: Partial<Record<RBone, V>>;
  hips?: V;
  root?: V;
  hL?: V;
  hR?: V;
  eL?: V;
  eR?: V;
  fL?: V;
  fR?: V;
  kL?: V;
  kR?: V;
  oL?: V; // hand orientation, chest frame, euler YXZ degrees
  oR?: V;
};

export type OscDef = {
  ch: string; // e.g. 'r.head', 'hips', 'hR'
  i: number; // component
  amp: number; // degrees for r.*/root yaw, metres otherwise
  cycles?: number; // cycles per clip duration (looping clips)
  hz?: number; // or a free frequency
  phase?: number; // 0..1
  from?: number; // envelope start/end (s); fades in/out over `fade`
  to?: number;
  fade?: number;
};

export type PropKind = 'glyphL' | 'ggSign' | 'mic' | 'teacup' | 'saucer';

export type PropKeyDef = {
  t: number;
  e?: Ease;
  p?: V; // position in the bone's frame (m)
  r?: V; // euler YXZ (degrees)
  s?: number; // uniform scale
};

export type PropDef = {
  kind: PropKind;
  bone: RBone; // the bone it rides ('root' = ground space)
  from?: number; // visible window (s); defaults to the whole clip
  to?: number;
  // Materialise / dematerialise time at the window edges (s), or [in, out]
  // (0 = appear / vanish on the frame — e.g. a hand-off between two props).
  pop?: number | readonly [number, number];
  keys?: PropKeyDef[];
};

export type ClipDef = {
  duration: number;
  loop: boolean;
  keys: KeyDef[];
  osc?: OscDef[];
  gun?: boolean; // the clip shows the railgun in hand
  props?: PropDef[];
};

type Channel = {
  target: string;
  bone: number; // r.* channels: bone index (else -1)
  dim: number;
  deg: boolean[];
  times: number[];
  values: number[][];
  eases: Ease[];
};

type Osc = OscDef & { bone: number; angle: boolean };

export type ClipProp = {
  kind: PropKind;
  bone: number;
  from: number;
  to: number;
  popIn: number;
  popOut: number;
  whole: boolean; // shown for the whole clip (no window edges)
  p: Channel | null;
  r: Channel | null;
  s: Channel | null;
};

export type Clip = {
  duration: number;
  loop: boolean;
  gun: boolean;
  channels: Channel[];
  osc: Osc[];
  props: ClipProp[];
};

const DEG = Math.PI / 180;

export function ease(kind: Ease, u: number): number {
  switch (kind) {
    case 'linear':
      return u;
    case 'in':
      return u * u * u;
    case 'out': {
      const v = 1 - u;
      return 1 - v * v * v;
    }
    case 'outBack': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
    }
    case 'inBack': {
      const c1 = 1.70158;
      return (c1 + 1) * u * u * u - c1 * u * u;
    }
    case 'outElastic': {
      if (u <= 0 || u >= 1) return u;
      return Math.pow(2, -9 * u) * Math.sin((u * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
    }
    case 'hold':
      return u >= 1 ? 1 : 0;
    case 'inOut':
    default:
      return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
  }
}

const VEC_KEYS = ['hips', 'root', 'hL', 'hR', 'eL', 'eR', 'fL', 'fR', 'kL', 'kR', 'oL', 'oR'] as const;

export function compileClip(def: ClipDef): Clip {
  const map = new Map<string, Channel>();
  const get = (target: string, dim: number, deg: boolean[]) => {
    let c = map.get(target);
    if (!c) {
      const bone = target.startsWith('r.') ? (BONE_INDEX[target.slice(2) as BoneName] ?? -1) : -1;
      c = { target, bone, dim, deg, times: [], values: [], eases: [] };
      map.set(target, c);
    }
    return c;
  };
  const keys = [...def.keys].sort((a, b) => a.t - b.t);
  for (const k of keys) {
    const e = k.e ?? 'inOut';
    if (k.r) {
      for (const [bone, v] of Object.entries(k.r)) {
        if (!v) continue;
        const c = get(`r.${bone}`, 3, [true, true, true]);
        c.times.push(k.t);
        c.values.push([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0]);
        c.eases.push(e);
      }
    }
    for (const name of VEC_KEYS) {
      const v = k[name];
      if (!v) continue;
      const dim = name === 'root' ? 4 : 3;
      const isO = name === 'oL' || name === 'oR';
      const c = get(name, dim, name === 'root' ? [false, false, false, true] : [isO, isO, isO]);
      c.times.push(k.t);
      const arr: number[] = [];
      for (let i = 0; i < dim; i++) arr.push(v[i] ?? 0);
      c.values.push(arr);
      c.eases.push(e);
    }
  }
  // Pre-convert degrees.
  for (const c of map.values()) {
    for (const vals of c.values) for (let i = 0; i < c.dim; i++) if (c.deg[i]) vals[i] *= DEG;
  }
  return {
    duration: def.duration,
    loop: def.loop,
    gun: !!def.gun,
    channels: [...map.values()],
    osc: (def.osc ?? []).map((o) => ({
      ...o,
      bone: o.ch.startsWith('r.') ? (BONE_INDEX[o.ch.slice(2) as BoneName] ?? -1) : -1,
      angle: o.ch.startsWith('r.') || o.ch === 'oL' || o.ch === 'oR' || (o.ch === 'root' && o.i === 3),
    })),
    props: (def.props ?? []).map((p) => compileProp(p, def.duration)),
  };
}

function compileProp(def: PropDef, dur: number): ClipProp {
  const mk = (target: string, dim: number, deg: boolean): Channel => ({
    target,
    bone: -1,
    dim,
    deg: Array.from({ length: dim }, () => deg),
    times: [],
    values: [],
    eases: [],
  });
  const p = mk('p', 3, false);
  const r = mk('r', 3, true);
  const s = mk('s', 1, false);
  for (const k of [...(def.keys ?? [])].sort((a, b) => a.t - b.t)) {
    const e = k.e ?? 'inOut';
    if (k.p) {
      p.times.push(k.t);
      p.values.push([k.p[0] ?? 0, k.p[1] ?? 0, k.p[2] ?? 0]);
      p.eases.push(e);
    }
    if (k.r) {
      r.times.push(k.t);
      r.values.push([(k.r[0] ?? 0) * DEG, (k.r[1] ?? 0) * DEG, (k.r[2] ?? 0) * DEG]);
      r.eases.push(e);
    }
    if (k.s !== undefined) {
      s.times.push(k.t);
      s.values.push([k.s]);
      s.eases.push(e);
    }
  }
  const from = def.from ?? 0;
  const to = def.to ?? dur;
  const pop = def.pop ?? 0.14;
  return {
    kind: def.kind,
    bone: BONE_INDEX[def.bone] ?? 0,
    from,
    to,
    popIn: typeof pop === 'number' ? pop : pop[0],
    popOut: typeof pop === 'number' ? pop : pop[1],
    whole: from <= 0 && to >= dur,
    p: p.times.length ? p : null,
    r: r.times.length ? r : null,
    s: s.times.length ? s : null,
  };
}

// Clip-local time (wrapped for loops, clamped otherwise).
export function clipTime(clip: Clip, t: number): number {
  const dur = clip.duration;
  return clip.loop ? ((t % dur) + dur) % dur : Math.min(Math.max(t, 0), dur);
}

// A prop's pose at clip-local time `tt`: writes position (m) and euler
// (radians, YXZ) and returns its scale including the window envelope
// (0 = hidden). Materialising pops in with a little overshoot.
export function evalProp(clip: Clip, prop: ClipProp, tt: number, pos: number[], rot: number[]): number {
  if (!prop.whole && (tt < prop.from || tt > prop.to)) return 0;
  const dur = clip.duration;
  if (prop.p) sampleChannel(prop.p, tt, dur, clip.loop, pos);
  else pos[0] = pos[1] = pos[2] = 0;
  if (prop.r) sampleChannel(prop.r, tt, dur, clip.loop, rot);
  else rot[0] = rot[1] = rot[2] = 0;
  let s = 1;
  if (prop.s) {
    sampleChannel(prop.s, tt, dur, clip.loop, _val);
    s = _val[0];
  }
  if (prop.whole) return s;
  const a = prop.popIn > 0 ? Math.min(1, (tt - prop.from) / prop.popIn) : 1;
  const b = prop.popOut > 0 ? Math.min(1, (prop.to - tt) / prop.popOut) : 1;
  return s * ease('outBack', Math.max(0, a)) * ease('out', Math.max(0, b));
}

const _val = [0, 0, 0, 0];

function sampleChannel(c: Channel, t: number, dur: number, loop: boolean, out: number[]): void {
  const n = c.times.length;
  if (n === 1) {
    for (let i = 0; i < c.dim; i++) out[i] = c.values[0][i];
    return;
  }
  let i0 = -1;
  for (let i = 0; i < n; i++) if (c.times[i] <= t) i0 = i;
  let ta: number, tb: number, a: number[], b: number[], e: Ease;
  if (i0 < 0) {
    if (!loop) {
      for (let i = 0; i < c.dim; i++) out[i] = c.values[0][i];
      return;
    }
    ta = c.times[n - 1] - dur;
    tb = c.times[0];
    a = c.values[n - 1];
    b = c.values[0];
    e = c.eases[0];
  } else if (i0 === n - 1) {
    if (!loop) {
      for (let i = 0; i < c.dim; i++) out[i] = c.values[n - 1][i];
      return;
    }
    ta = c.times[n - 1];
    tb = c.times[0] + dur;
    a = c.values[n - 1];
    b = c.values[0];
    e = c.eases[0];
  } else {
    ta = c.times[i0];
    tb = c.times[i0 + 1];
    a = c.values[i0];
    b = c.values[i0 + 1];
    e = c.eases[i0 + 1];
  }
  const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
  const k = ease(e, u);
  for (let i = 0; i < c.dim; i++) out[i] = a[i] + (b[i] - a[i]) * k;
}

// Evaluate `clip` at time t (seconds) on top of the spec's current values
// (channels the clip never keys keep whatever the spec had — the base stance).
export function evalClip(clip: Clip, t: number, spec: PoseSpec): void {
  const dur = clip.duration;
  const tt = clip.loop ? ((t % dur) + dur) % dur : Math.min(Math.max(t, 0), dur);
  for (const c of clip.channels) {
    sampleChannel(c, tt, dur, clip.loop, _val);
    if (c.bone >= 0) spec.setR(c.bone, _val[0], _val[1], _val[2]);
    else writeChannel(spec, c.target, _val, false);
  }
  for (const o of clip.osc) {
    let w = 1;
    if (o.from !== undefined || o.to !== undefined) {
      const f = o.fade ?? 0.2;
      const a = o.from ?? 0;
      const b = o.to ?? dur;
      if (tt < a || tt > b) continue;
      w = Math.min(1, (tt - a) / f, (b - tt) / f);
    }
    const freq = o.hz ?? (o.cycles ?? 1) / dur;
    const s = Math.sin((tt * freq + (o.phase ?? 0)) * Math.PI * 2) * o.amp * w;
    _val[0] = _val[1] = _val[2] = _val[3] = 0;
    _val[o.i] = o.angle ? s * DEG : s;
    if (o.bone >= 0) spec.addR(o.bone, _val[0], _val[1], _val[2]);
    else writeChannel(spec, o.ch, _val, true);
  }
}

function writeVec(dst: { x: number; y: number; z: number }, v: number[], add: boolean): void {
  if (add) {
    dst.x += v[0];
    dst.y += v[1];
    dst.z += v[2];
  } else {
    dst.x = v[0];
    dst.y = v[1];
    dst.z = v[2];
  }
}

function writeChannel(spec: PoseSpec, target: string, v: number[], add: boolean): void {
  if (target.charCodeAt(0) === 114 /* r */ && target.charCodeAt(1) === 46 /* . */) {
    const bone = BONE_INDEX[target.slice(2) as BoneName];
    if (bone === undefined) return;
    if (add) spec.addR(bone, v[0], v[1], v[2]);
    else spec.setR(bone, v[0], v[1], v[2]);
    return;
  }
  switch (target) {
    case 'hips':
      writeVec(spec.hips, v, add);
      break;
    case 'root':
      writeVec(spec.root, v, add);
      // Root yaw rides r.root's Y.
      if (add) spec.r[1] += v[3];
      else spec.r[1] = v[3];
      break;
    case 'hL':
      writeVec(spec.hand[SIDE_L], v, add);
      break;
    case 'hR':
      writeVec(spec.hand[SIDE_R], v, add);
      break;
    case 'eL':
      writeVec(spec.elbow[SIDE_L], v, add);
      break;
    case 'eR':
      writeVec(spec.elbow[SIDE_R], v, add);
      break;
    case 'fL':
      writeVec(spec.foot[SIDE_L], v, add);
      break;
    case 'fR':
      writeVec(spec.foot[SIDE_R], v, add);
      break;
    case 'kL':
      writeVec(spec.knee[SIDE_L], v, add);
      break;
    case 'kR':
      writeVec(spec.knee[SIDE_R], v, add);
      break;
    case 'oL':
      writeVec(spec.handE[SIDE_L], v, add);
      spec.handEOn[SIDE_L] = true;
      break;
    case 'oR':
      writeVec(spec.handE[SIDE_R], v, add);
      spec.handEOn[SIDE_R] = true;
      break;
  }
}
