// ── Replay codec ─────────────────────────────────────────────────────────────
//
// A compact, self-contained binary format for a full match replay. It is PURE
// data (no THREE, no DOM) so BOTH the client (record → encode → upload, and
// download → decode → play) AND the server (decode the header to validate a
// submitted run, then store the blob) can import it.
//
// The client records the run client-side (offline vs bots), encodes it here, and
// uploads it with its weekly-challenge submission. Anyone can later download and
// replay it (transparency / anti-cheat — you can watch exactly where the runner
// aimed and moved). Quantization mirrors the netcode wire format: positions as
// i16 ×256 (~3.9 mm) over ±128 m, angles as i16 over [-π, π].

import type { Vec3 } from './types';

export type ReplayActorKind = 'local' | 'remote' | 'bot';

export type ReplayActorProfile = {
  id: string;
  name: string;
  kind: ReplayActorKind;
  hat: string;
  unusual: string;
  nameColor: string;
  team: number | null;
};

export type ReplayPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number; // look pitch (radians) — drives the first-person replay camera
  visible: boolean;
};

export type ReplayFrame = { t: number; poses: Record<string, ReplayPose> };

export type ReplayKill = {
  t: number;
  killerId: string;
  victimId: string;
  headshot: boolean;
  killerName: string;
  victimName: string;
};

export type ReplayShot = { t: number; origin: Vec3; end: Vec3; killerId: string };

// The full decoded replay. `localId` is the actor whose eyes we ride in playback
// (the runner). `won`/`durationMs` summarize the run for the leaderboard + the
// server's sanity check that the submitted score matches the recording.
export type ReplayData = {
  version: number;
  hz: number;
  mapId: string;
  durationMs: number;
  localId: string;
  won: boolean;
  profiles: ReplayActorProfile[];
  frames: ReplayFrame[];
  kills: ReplayKill[];
  shots: ReplayShot[];
};

export const REPLAY_VERSION = 1;
const MAGIC = 0x49475231; // "IGR1"

const POS_SCALE = 256; // i16 ×256 → ±127.99 m at ~3.9 mm
const ANG_SCALE = 32767 / Math.PI; // map [-π, π] → i16

const KIND_TO_N: Record<ReplayActorKind, number> = { local: 0, remote: 1, bot: 2 };
const N_TO_KIND: ReplayActorKind[] = ['local', 'remote', 'bot'];

function clampI16(n: number): number {
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n | 0;
}
const qPos = (m: number) => clampI16(Math.round(m * POS_SCALE));
const dqPos = (q: number) => q / POS_SCALE;
const qAng = (r: number) => clampI16(Math.round(wrapPi(r) * ANG_SCALE));
const dqAng = (q: number) => q / ANG_SCALE;

function wrapPi(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// Largest length ≤ `max` that ends on a UTF-8 code-point boundary: back off over
// any continuation bytes (10xxxxxx) so a clamp never splits a multi-byte glyph.
function utf8BoundaryAtOrBefore(bytes: Uint8Array, max: number): number {
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return end;
}

// ── Growable little-endian writer ────────────────────────────────────────────
class ByteWriter {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private enc = new TextEncoder();

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.pos, v & 0xff); this.pos += 1; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.pos, v & 0xffff, true); this.pos += 2; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  str(s: string) {
    const bytes = this.enc.encode(s ?? '');
    // Length is a u16; clamp on a UTF-8 boundary rather than let a pathologically
    // long string silently wrap the prefix and desync the stream. Names are short
    // in practice; this just hardens the codec as a reusable module.
    const len = bytes.length > 0xffff ? utf8BoundaryAtOrBefore(bytes, 0xffff) : bytes.length;
    this.u16(len);
    this.ensure(len);
    this.buf.set(bytes.subarray(0, len), this.pos);
    this.pos += len;
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

// ── Little-endian reader ──────────────────────────────────────────────────────
class ByteReader {
  private pos = 0;
  private dec = new TextDecoder();
  constructor(private view: DataView, private u8arr: Uint8Array) {}
  get remaining(): number { return this.view.byteLength - this.pos; }
  u8(): number { const v = this.view.getUint8(this.pos); this.pos += 1; return v; }
  i8(): number { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
  u16(): number { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  str(): string {
    const len = this.u16();
    const s = this.dec.decode(this.u8arr.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }
}

// ── Encode ─────────────────────────────────────────────────────────────────-─
export function encodeReplay(data: ReplayData): Uint8Array {
  const w = new ByteWriter();
  const idxOf = new Map<string, number>();
  data.profiles.forEach((p, i) => idxOf.set(p.id, i));
  const NONE = 0xffff;
  const aCount = data.profiles.length;
  const bitmaskBytes = Math.ceil(aCount / 8);

  // Header.
  w.u32(MAGIC);
  w.u8(data.version);
  w.u8(Math.max(1, Math.min(255, data.hz | 0)));
  w.u8(data.won ? 1 : 0);
  w.u16(idxOf.get(data.localId) ?? NONE);
  w.u32(Math.max(0, data.durationMs | 0));
  w.u16(aCount);
  w.u32(data.frames.length);
  w.u16(Math.min(0xffff, data.kills.length));
  w.u16(Math.min(0xffff, data.shots.length));
  w.str(data.mapId);

  // Actor table.
  for (const p of data.profiles) {
    w.str(p.id);
    w.str(p.name);
    w.u8(KIND_TO_N[p.kind] ?? 1);
    w.str(p.hat);
    w.str(p.unusual);
    w.str(p.nameColor);
    w.i8(p.team == null ? -1 : Math.max(-1, Math.min(127, p.team | 0)));
  }

  // Frames: absolute time (ms) + a presence bitmask + each present actor's pose.
  for (const f of data.frames) {
    w.u32(Math.max(0, Math.round(f.t * 1000)));
    const present: number[] = [];
    const mask = new Uint8Array(bitmaskBytes);
    for (let i = 0; i < aCount; i++) {
      const id = data.profiles[i].id;
      if (f.poses[id]) {
        mask[i >> 3] |= 1 << (i & 7);
        present.push(i);
      }
    }
    for (let b = 0; b < bitmaskBytes; b++) w.u8(mask[b]);
    for (const i of present) {
      const pose = f.poses[data.profiles[i].id];
      w.u8(pose.visible ? 1 : 0);
      w.i16(qPos(pose.x));
      w.i16(qPos(pose.y));
      w.i16(qPos(pose.z));
      w.i16(qAng(pose.yaw));
      w.i16(qAng(pose.pitch));
    }
  }

  // Kills (names recoverable from the actor table by index).
  const killN = Math.min(0xffff, data.kills.length);
  for (let i = 0; i < killN; i++) {
    const k = data.kills[i];
    w.u32(Math.max(0, Math.round(k.t * 1000)));
    w.u16(idxOf.get(k.killerId) ?? NONE);
    w.u16(idxOf.get(k.victimId) ?? NONE);
    w.u8(k.headshot ? 1 : 0);
  }

  // Shots.
  const shotN = Math.min(0xffff, data.shots.length);
  for (let i = 0; i < shotN; i++) {
    const s = data.shots[i];
    w.u32(Math.max(0, Math.round(s.t * 1000)));
    w.u16(idxOf.get(s.killerId) ?? NONE);
    w.i16(qPos(s.origin.x)); w.i16(qPos(s.origin.y)); w.i16(qPos(s.origin.z));
    w.i16(qPos(s.end.x)); w.i16(qPos(s.end.y)); w.i16(qPos(s.end.z));
  }

  return w.bytes();
}

// ── Decode ─────────────────────────────────────────────────────────────────-─
// Throws on a malformed/foreign buffer; callers wrap in try/catch.
export function decodeReplay(input: ArrayBuffer | Uint8Array): ReplayData {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const r = new ByteReader(view, u8);
  const NONE = 0xffff;

  if (r.u32() !== MAGIC) throw new Error('replay: bad magic');
  const version = r.u8();
  if (version !== REPLAY_VERSION) throw new Error(`replay: unsupported version ${version}`);
  const hz = r.u8();
  const won = r.u8() === 1;
  const localIdx = r.u16();
  const durationMs = r.u32();
  const aCount = r.u16();
  const frameCount = r.u32();
  const killCount = r.u16();
  const shotCount = r.u16();
  const mapId = r.str();
  const bitmaskBytes = Math.ceil(aCount / 8);

  const profiles: ReplayActorProfile[] = [];
  for (let i = 0; i < aCount; i++) {
    const id = r.str();
    const name = r.str();
    const kind = N_TO_KIND[r.u8()] ?? 'remote';
    const hat = r.str();
    const unusual = r.str();
    const nameColor = r.str();
    const teamRaw = r.i8();
    profiles.push({ id, name, kind, hat, unusual, nameColor, team: teamRaw < 0 ? null : teamRaw });
  }
  const idName = (idx: number) => (idx === NONE ? '' : profiles[idx]?.name ?? '');
  const idAt = (idx: number) => (idx === NONE ? '' : profiles[idx]?.id ?? '');

  const frames: ReplayFrame[] = new Array(frameCount);
  for (let fi = 0; fi < frameCount; fi++) {
    const t = r.u32() / 1000;
    const mask = new Uint8Array(bitmaskBytes);
    for (let b = 0; b < bitmaskBytes; b++) mask[b] = r.u8();
    const poses: Record<string, ReplayPose> = {};
    for (let i = 0; i < aCount; i++) {
      if (!(mask[i >> 3] & (1 << (i & 7)))) continue;
      const visible = r.u8() === 1;
      const x = dqPos(r.i16());
      const y = dqPos(r.i16());
      const z = dqPos(r.i16());
      const yaw = dqAng(r.i16());
      const pitch = dqAng(r.i16());
      poses[profiles[i].id] = { x, y, z, yaw, pitch, visible };
    }
    frames[fi] = { t, poses };
  }

  const kills: ReplayKill[] = new Array(killCount);
  for (let i = 0; i < killCount; i++) {
    const t = r.u32() / 1000;
    const ki = r.u16();
    const vi = r.u16();
    const headshot = r.u8() === 1;
    kills[i] = {
      t,
      killerId: idAt(ki),
      victimId: idAt(vi),
      headshot,
      killerName: idName(ki),
      victimName: idName(vi),
    };
  }

  const shots: ReplayShot[] = new Array(shotCount);
  for (let i = 0; i < shotCount; i++) {
    const t = r.u32() / 1000;
    const ki = r.u16();
    const ox = dqPos(r.i16()), oy = dqPos(r.i16()), oz = dqPos(r.i16());
    const ex = dqPos(r.i16()), ey = dqPos(r.i16()), ez = dqPos(r.i16());
    shots[i] = { t, killerId: idAt(ki), origin: { x: ox, y: oy, z: oz }, end: { x: ex, y: ey, z: ez } };
  }

  const localId = localIdx === NONE ? '' : profiles[localIdx]?.id ?? '';
  return { version, hz, mapId, durationMs, localId, won, profiles, frames, kills, shots };
}

// Cheap server-side summary used to sanity-check a submitted score against the
// recording it claims to be (the replay is the evidence — its own kills/time must
// match the reported run, or it's rejected). Returns null on a malformed buffer.
export type ReplaySummary = {
  durationMs: number;
  localKills: number;
  won: boolean;
  mapId: string;
  frameCount: number;
  actorCount: number;
};

export function summarizeReplay(input: ArrayBuffer | Uint8Array): ReplaySummary | null {
  try {
    const data = decodeReplay(input);
    let localKills = 0;
    for (const k of data.kills) if (k.killerId === data.localId) localKills++;
    return {
      durationMs: data.durationMs,
      localKills,
      won: data.won,
      mapId: data.mapId,
      frameCount: data.frames.length,
      actorCount: data.profiles.length,
    };
  } catch {
    return null;
  }
}
