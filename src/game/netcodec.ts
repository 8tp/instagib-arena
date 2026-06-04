// THREE-free binary codec for the two HOT, high-rate game messages: the per-tick
// state snapshot (server→client) and the position upload (client→server). These
// dominate the wire and the JSON.parse cost at 64Hz; everything else (join, kill,
// meta, chat, vote…) stays JSON because it's rare and/or structural.
//
// Layout is little-endian via DataView. Player ids are server-generated ASCII
// (base36/hex), length-prefixed. Floats are full f32 (no quantization → no
// precision artifacts on large maps); the small change-rarely ints are u16.
//
// Shared verbatim by client (browser, ArrayBuffer) and server (Node, Buffer) —
// `toView` adapts either into a DataView. This module imports nothing.

export const BIN_STATE = 1; // server → client: a state snapshot
export const BIN_POS = 2; // client → server: a position update

export type BinStatePlayer = {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  frags: number;
  deaths: number;
  invulnMs: number;
  ping: number;
};

const STATE_HEADER = 1 + 8 + 8 + 1; // tag + t(f64) + resumeAt(f64) + count(u8)
const POS_BYTES = 1 + 5 * 4; // tag + 5×f32

const clampU16 = (n: number) => (n <= 0 ? 0 : n >= 65535 ? 65535 : n | 0);

// Wrap a browser ArrayBuffer or a Node Buffer/typed array as a DataView.
export function toView(data: ArrayBuffer | ArrayBufferView): DataView {
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function encodeState(t: number, players: BinStatePlayer[], resumeAt: number): Uint8Array {
  const n = Math.min(players.length, 255);
  let size = STATE_HEADER;
  for (let i = 0; i < n; i++) size += 1 + Math.min(players[i].id.length, 255) + 5 * 4 + 4 * 2;
  const dv = new DataView(new ArrayBuffer(size));
  let o = 0;
  dv.setUint8(o, BIN_STATE); o += 1;
  dv.setFloat64(o, t, true); o += 8;
  dv.setFloat64(o, resumeAt, true); o += 8;
  dv.setUint8(o, n); o += 1;
  for (let i = 0; i < n; i++) {
    const p = players[i];
    const idLen = Math.min(p.id.length, 255);
    dv.setUint8(o, idLen); o += 1;
    for (let j = 0; j < idLen; j++) { dv.setUint8(o, p.id.charCodeAt(j) & 0xff); o += 1; }
    dv.setFloat32(o, p.x, true); o += 4;
    dv.setFloat32(o, p.y, true); o += 4;
    dv.setFloat32(o, p.z, true); o += 4;
    dv.setFloat32(o, p.yaw, true); o += 4;
    dv.setFloat32(o, p.pitch, true); o += 4;
    dv.setUint16(o, clampU16(p.frags), true); o += 2;
    dv.setUint16(o, clampU16(p.deaths), true); o += 2;
    dv.setUint16(o, clampU16(p.invulnMs), true); o += 2;
    dv.setUint16(o, clampU16(p.ping), true); o += 2;
  }
  return new Uint8Array(dv.buffer);
}

export function decodeState(
  dv: DataView,
): { t: number; resumeAt: number; players: BinStatePlayer[] } | null {
  if (dv.byteLength < STATE_HEADER || dv.getUint8(0) !== BIN_STATE) return null;
  let o = 1;
  const t = dv.getFloat64(o, true); o += 8;
  const resumeAt = dv.getFloat64(o, true); o += 8;
  const count = dv.getUint8(o); o += 1;
  const players: BinStatePlayer[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 1 > dv.byteLength) return null;
    const idLen = dv.getUint8(o); o += 1;
    // Bounds-check the WHOLE row (id bytes + 5×f32 + 4×u16) before reading, so a
    // truncated / corrupt / fragmented-short frame returns null per this
    // function's contract instead of throwing a RangeError mid-decode.
    if (o + idLen + 5 * 4 + 4 * 2 > dv.byteLength) return null;
    let id = '';
    for (let j = 0; j < idLen; j++) { id += String.fromCharCode(dv.getUint8(o)); o += 1; }
    const x = dv.getFloat32(o, true); o += 4;
    const y = dv.getFloat32(o, true); o += 4;
    const z = dv.getFloat32(o, true); o += 4;
    const yaw = dv.getFloat32(o, true); o += 4;
    const pitch = dv.getFloat32(o, true); o += 4;
    const frags = dv.getUint16(o, true); o += 2;
    const deaths = dv.getUint16(o, true); o += 2;
    const invulnMs = dv.getUint16(o, true); o += 2;
    const ping = dv.getUint16(o, true); o += 2;
    players.push({ id, x, y, z, yaw, pitch, frags, deaths, invulnMs, ping });
  }
  return { t, resumeAt, players };
}

export function encodePos(x: number, y: number, z: number, yaw: number, pitch: number): Uint8Array {
  const dv = new DataView(new ArrayBuffer(POS_BYTES));
  dv.setUint8(0, BIN_POS);
  dv.setFloat32(1, x, true);
  dv.setFloat32(5, y, true);
  dv.setFloat32(9, z, true);
  dv.setFloat32(13, yaw, true);
  dv.setFloat32(17, pitch, true);
  return new Uint8Array(dv.buffer);
}

export function decodePos(
  dv: DataView,
): { x: number; y: number; z: number; yaw: number; pitch: number } | null {
  if (dv.byteLength < POS_BYTES || dv.getUint8(0) !== BIN_POS) return null;
  return {
    x: dv.getFloat32(1, true),
    y: dv.getFloat32(5, true),
    z: dv.getFloat32(9, true),
    yaw: dv.getFloat32(13, true),
    pitch: dv.getFloat32(17, true),
  };
}
