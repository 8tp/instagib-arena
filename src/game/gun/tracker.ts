import * as THREE from 'three';
import { nowMs } from '../fx/rail-state';
import { fxFlags } from '../fx/fx-settings';
import { GunBuilder, PART, TRACKER_MOUNT, chamferBox, type TrackerMount } from './gun-geometry';
import { gunFx, type GunMaterial } from './gun-material';

// ─────────────────────────────────────────────────────────────────────────
// Tracked kill counter (the 'strange' quality, shown to players as
// "Tracked"): a small machined module bolted to the gun's camera-facing −X
// flank — a chamfered housing on a bracket that hooks under the receiver,
// four screws, a bright bezel, and a recessed backlit LCD reading the item's
// confirmed kills as six seven-segment digits (unlit ghost segments, leading
// zeros dark) beside a "TRACKED" label.
//
//   • Housing: one small merged geometry in the gun's own surface material
//     (same `gun` part attribute, so it wears the finish's metal + machined
//     edges); cached, shared. Display: a glossy dark glass plane whose
//     emissive map is a CanvasTexture (mipmapped, anisotropic) redrawn only
//     when the count changes or while a digit is rolling. +2 draws, and only
//     on a Tracked gun.
//   • On a kill the digits that changed roll up (old out the top, new in from
//     below, ~0.3 s) and flash; time-based, so identical at any frame rate.
//     Reduced effects: no roll, a soft brightness swell. Low-spec: no roll.
//   • Radiance: the lit segments sit at ~1.2 linear (readable, not a lamp),
//     the kill flash peaks at ~1.4 — under the bloom threshold (1.5).
//   • Local frame: x = 0 is the mounting face (the gun flank), the display
//     faces −X, +Z runs toward the butt (text reads muzzle → butt), +Y up.
//     Seated by a TrackerMount (model space) — gun-geometry's TRACKER_MOUNT on
//     the standard gun; a custom model provides its own.
// ─────────────────────────────────────────────────────────────────────────

const DIGITS = 6;
const MAX = 10 ** DIGITS - 1;

// Module dimensions (m).
const L = 0.136; // housing length (along Z)
const H = 0.046; // housing height
const D = 0.0085; // housing depth off the bracket
const BR = 0.0035; // bracket plate thickness
const DW = 0.112; // display window
const DH = 0.033;
const FACE_X = -(BR + D); // housing face
const BEZEL = 0.003; // bezel bar section
const DISPLAY_X = FACE_X - 0.0006;

// Canvas: 1024 px across the 112 mm window (≈ 9 px/mm).
const CW = 1024;
const CH = Math.round((CW * DH) / DW);
const LABEL_W = 214; // label column (muzzle side)

// Backlight: lit bars ≈ 1.2 linear at rest, ≤ ~1.4 at the kill flash (the
// bloom threshold is 1.5 — readable, never a lamp).
const LCD_K = 1.2;
const ROLL_SEC = 0.32;
const FLASH_SEC = 0.9;
const REDRAW_MIN_MS = 1000 / 60; // redraw cap while animating (upload budget)

// ── Housing geometry (cached per hook variant) ──────────────────────────────

const housingCache = new Map<string, THREE.BufferGeometry>();

function housingGeometry(hook: boolean): THREE.BufferGeometry {
  const key = hook ? 'hook' : 'flat';
  let g = housingCache.get(key);
  if (g) return g;
  const b = new GunBuilder();
  const P = PART;
  // Bracket: a plate on the flank, longer than the housing, with an ear and a
  // hex screw at each end.
  b.put(P.METAL, chamferBox(BR, H - 0.004, L + 0.03, 0.0012), [-BR / 2, 0, 0]);
  for (const sz of [-1, 1]) {
    b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0034, 0.0034, 0.0022, 6), [-BR - 0.001, 0, sz * (L / 2 + 0.0085)], [0, 0, Math.PI / 2], 'none');
    b.put(P.RUBBER, new THREE.BoxGeometry(0.0008, 0.0006, 0.0042), [-BR - 0.0022, 0, sz * (L / 2 + 0.0085)], undefined, 'none');
  }
  if (hook) {
    // The bracket follows the receiver's 45° lower chamfer and hooks under it.
    b.put(P.METAL, chamferBox(0.003, 0.022, L * 0.72, 0.001), [0.0075, -H / 2 + 0.0085, 0], [0, 0, Math.PI / 4]);
    b.put(P.METAL, chamferBox(0.012, 0.003, L * 0.72, 0.001), [0.018, -H / 2 + 0.0004, 0]);
  }
  // Housing: a chamfered block.
  b.put(P.METAL, chamferBox(D, H, L, 0.0028), [-BR - D / 2, 0, 0]);
  // Bezel: four bright machined bars round the recessed window.
  const bx = FACE_X - BEZEL / 2 + 0.0004;
  b.put(P.METAL_LT, chamferBox(BEZEL, BEZEL, DW + 2 * BEZEL, 0.0009), [bx, DH / 2 + BEZEL / 2, 0]);
  b.put(P.METAL_LT, chamferBox(BEZEL, BEZEL, DW + 2 * BEZEL, 0.0009), [bx, -DH / 2 - BEZEL / 2, 0]);
  b.put(P.METAL_LT, chamferBox(BEZEL, DH, BEZEL, 0.0009), [bx, 0, DW / 2 + BEZEL / 2]);
  b.put(P.METAL_LT, chamferBox(BEZEL, DH, BEZEL, 0.0009), [bx, 0, -DW / 2 - BEZEL / 2]);
  // Screws in the housing's four corners, outside the bezel.
  const sz0 = DW / 2 + BEZEL + (L / 2 - DW / 2 - BEZEL) / 2;
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      b.put(P.METAL_LT, new THREE.CylinderGeometry(0.0021, 0.0021, 0.0014, 6), [FACE_X - 0.0005, sy * 0.012, sz * sz0], [0, 0, Math.PI / 2], 'none');
    }
  }
  // A status pip under the label side (the gun's glow knob: it pops per shot).
  b.put(P.GLOW, new THREE.BoxGeometry(0.0012, 0.0016, 0.006), [FACE_X - 0.0003, -DH / 2 - BEZEL - 0.0025, -DW / 2 + 0.012], undefined, 'none');
  g = b.merge();
  g.name = `railgun-tracker-${key}`;
  g.userData.shared = true;
  housingCache.set(key, g);
  return g;
}

let displayGeo: THREE.PlaneGeometry | null = null;
function displayGeometry(): THREE.PlaneGeometry {
  if (!displayGeo) {
    displayGeo = new THREE.PlaneGeometry(DW, DH);
    displayGeo.rotateY(-Math.PI / 2); // faces −X, u runs toward +Z
    displayGeo.translate(DISPLAY_X, 0, 0);
    displayGeo.userData.shared = true;
  }
  return displayGeo;
}

// ── Seven segments ──────────────────────────────────────────────────────────

// Segment masks a…g (bit 0 = a top, 1 = b top-right, 2 = c bottom-right,
// 3 = d bottom, 4 = e bottom-left, 5 = f top-left, 6 = g middle).
const SEG: Record<string, number> = {
  '0': 0b0111111,
  '1': 0b0000110,
  '2': 0b1011011,
  '3': 0b1001111,
  '4': 0b1100110,
  '5': 0b1101101,
  '6': 0b1111101,
  '7': 0b0000111,
  '8': 0b1111111,
  '9': 0b1101111,
};

// Trace one hexagonal segment bar from (x0,y0) to (x1,y1) (thickness t).
function bar(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, t: number, slant: number, oy: number) {
  const h = t / 2;
  const sk = (x: number, y: number): [number, number] => [x - (y - oy) * slant, y];
  const pts: Array<[number, number]> =
    x0 === x1
      ? [[x0, y0], [x0 + h, y0 + h], [x0 + h, y1 - h], [x0, y1], [x0 - h, y1 - h], [x0 - h, y0 + h]]
      : [[x0, y0], [x0 + h, y0 - h], [x1 - h, y0 - h], [x1, y0], [x1 - h, y0 + h], [x0 + h, y0 + h]];
  ctx.moveTo(...sk(pts[0][0], pts[0][1]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(...sk(pts[i][0], pts[i][1]));
  ctx.closePath();
}

// Path of the segments in `mask` for a digit cell at (x, y) sized w × h.
function segPath(ctx: CanvasRenderingContext2D, mask: number, x: number, y: number, w: number, h: number) {
  const t = w * 0.22;
  const g = t * 0.12; // gap between neighbouring segments
  const l = x + t / 2, r = x + w - t / 2;
  const top = y + t / 2, mid = y + h / 2, bot = y + h - t / 2;
  const slant = 0.09;
  const oy = y + h / 2;
  ctx.beginPath();
  if (mask & 1) bar(ctx, l + g, top, r - g, top, t, slant, oy);
  if (mask & 2) bar(ctx, r, top + g, r, mid - g, t, slant, oy);
  if (mask & 4) bar(ctx, r, mid + g, r, bot - g, t, slant, oy);
  if (mask & 8) bar(ctx, l + g, bot, r - g, bot, t, slant, oy);
  if (mask & 16) bar(ctx, l, mid + g, l, bot - g, t, slant, oy);
  if (mask & 32) bar(ctx, l, top + g, l, mid - g, t, slant, oy);
  if (mask & 64) bar(ctx, l + g, mid, r - g, mid, t, slant, oy);
}

function hexCss(c: THREE.Color, k = 1): string {
  const f = (v: number) => Math.round(Math.max(0, Math.min(1, v * k)) * 255);
  return `rgb(${f(c.r)},${f(c.g)},${f(c.b)})`;
}

// ── The counter ─────────────────────────────────────────────────────────────

export type TrackerOptions = {
  // The housing's surface: the standard gun passes its own material (shared,
  // not owned); a custom model's counter gets its own (owned: disposed here).
  material: GunMaterial;
  ownsMaterial: boolean;
  mount?: TrackerMount;
  // The bracket's hook under the receiver's lower chamfer (standard gun only —
  // a custom model's flank is its own shape).
  hook?: boolean;
};

export class TrackedCounter {
  readonly group = new THREE.Group();
  private readonly housing: THREE.Mesh;
  private readonly display: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private readonly cv: HTMLCanvasElement | null;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly tex: THREE.CanvasTexture | null;
  private readonly lit = new THREE.Color();
  private readonly ghost = new THREE.Color();
  private readonly ownsMaterial: boolean;
  private readonly material: GunMaterial;
  private kills = -1;
  private prevText = '';
  private text = '';
  private changeMs = -1e9; // when the count last went up
  private rolling = false; // the roll/flash is still being drawn
  private lastDrawMs = -1e9;
  private low = false;

  constructor(opts: TrackerOptions) {
    this.material = opts.material;
    this.ownsMaterial = opts.ownsMaterial;
    const mount = opts.mount ?? TRACKER_MOUNT;
    this.group.name = 'railgun-tracker';
    this.group.position.set(...mount.position);
    this.group.rotation.y = mount.rotationY ?? 0;
    this.group.scale.setScalar(mount.scale ?? 1);
    this.group.visible = false;
    this.group.userData.strange = true;

    this.housing = new THREE.Mesh(housingGeometry(!!opts.hook), opts.material);
    this.housing.name = 'railgun-tracker-housing';
    this.housing.userData.shared = true; // cached geometry; material is the gun's (or freed by dispose)
    this.group.add(this.housing);

    this.cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (this.cv) {
      this.cv.width = CW;
      this.cv.height = CH;
    }
    this.ctx = this.cv?.getContext('2d') ?? null;
    this.tex = this.cv ? new THREE.CanvasTexture(this.cv) : null;
    if (this.tex) {
      this.tex.colorSpace = THREE.SRGBColorSpace;
      this.tex.anisotropy = 8;
      this.tex.generateMipmaps = true;
      this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    // Backlit LCD under glass: a dark glossy dielectric (it picks up the
    // arena's reflections like the rest of the gun) lit from behind by the
    // emissive map.
    const mat = new THREE.MeshStandardMaterial({
      color: 0x020304,
      roughness: 0.2,
      metalness: 0,
      emissive: 0xffffff,
      emissiveMap: this.tex,
      emissiveIntensity: LCD_K,
    });
    mat.name = 'railgun-tracker-lcd';
    this.display = new THREE.Mesh(displayGeometry(), mat);
    this.display.name = 'railgun-tracker-lcd';
    this.display.userData.shared = true; // shared plane; material freed by dispose()
    this.display.onBeforeRender = () => this.tick();
    this.group.add(this.display);
  }

  // Digit colour: the finish's hot accent, lifted toward white so it reads on
  // the dark glass whatever the hue.
  setColor(accentHot: number) {
    const c = new THREE.Color(accentHot);
    this.lit.copy(c).lerp(new THREE.Color(1, 1, 1), 0.22);
    this.ghost.copy(c);
    if (this.kills >= 0) this.draw(nowMs());
  }

  setLowSpec(low: boolean) {
    this.low = low;
  }

  // null hides the module; a number shows it (a rise rolls + flashes the
  // digits that changed).
  set(n: number | null) {
    if (n === null || !Number.isFinite(n)) {
      this.group.visible = false;
      this.kills = -1;
      this.text = '';
      return;
    }
    const v = Math.max(0, Math.min(MAX, Math.floor(n)));
    this.group.visible = true;
    if (v === this.kills) return;
    const grew = this.kills >= 0 && v > this.kills;
    const now = nowMs();
    this.prevText = grew ? this.text : '';
    this.text = String(v).padStart(DIGITS, ' ');
    this.kills = v;
    this.changeMs = grew ? now : -1e9;
    this.rolling = grew;
    this.draw(now);
  }

  get count(): number | null {
    return this.kills < 0 ? null : this.kills;
  }

  private tick() {
    const now = nowMs();
    const since = (now - this.changeMs) / 1000;
    const calm = gunFx.reduced;
    // The whole display swells a touch on a kill (≤ 1.3 — under the bloom knee).
    const flash = since >= 0 && since < FLASH_SEC ? Math.exp(-since * (calm ? 3 : 5)) : 0;
    this.display.material.emissiveIntensity = LCD_K * (1 + (calm ? 0.08 : 0.16) * flash);
    if (!this.rolling) return;
    if (since >= FLASH_SEC) {
      this.rolling = false;
      this.draw(now);
      return;
    }
    if (now - this.lastDrawMs >= REDRAW_MIN_MS) this.draw(now);
  }

  private draw(now: number) {
    const ctx = this.ctx;
    if (!ctx || this.kills < 0) return;
    this.lastDrawMs = now;
    const since = (now - this.changeMs) / 1000;
    const animate = this.rolling && !gunFx.reduced && !this.low && !fxFlags.low;
    const roll = animate ? Math.min(1, since / ROLL_SEC) : 1;
    const ease = 1 - (1 - roll) ** 3;
    const hot = this.rolling && since < FLASH_SEC ? Math.exp(-since * 4) : 0;

    ctx.save();
    ctx.clearRect(0, 0, CW, CH);
    // Glass: near-black, a faint vertical falloff so it reads as a lit panel.
    const bg = ctx.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, '#0b1116');
    bg.addColorStop(0.55, '#05080b');
    bg.addColorStop(1, '#030507');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CW, CH);
    const glow = hexCss(this.ghost);

    // ── Label column: reticle glyph + TRACKED / CONFIRMED KILLS ──
    const lc = LABEL_W / 2;
    ctx.strokeStyle = hexCss(this.lit, 0.9);
    ctx.fillStyle = hexCss(this.lit, 0.9);
    ctx.lineWidth = 7;
    const ry = CH * 0.32;
    const rr = CH * 0.13;
    ctx.beginPath();
    ctx.arc(lc, ry, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      ctx.moveTo(lc + dx * rr * 0.45, ry + dy * rr * 0.45);
      ctx.lineTo(lc + dx * rr * 1.45, ry + dy * rr * 1.45);
    }
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(lc, ry, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const fit = (text: string, weight: number, px: number, spacing: number, y: number, maxW: number) => {
      ctx.font = `${weight} ${px}px ui-sans-serif, "Segoe UI", "DejaVu Sans", Arial, sans-serif`;
      ctx.letterSpacing = `${spacing}px`;
      const w = ctx.measureText(text).width;
      const k = w > maxW ? maxW / w : 1;
      ctx.save();
      ctx.translate(lc, y);
      ctx.scale(k, 1);
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    fit('TRACKED', 800, Math.round(CH * 0.165), 4, CH * 0.74, LABEL_W - 26);
    ctx.globalAlpha = 0.6;
    fit('CONFIRMED KILLS', 700, Math.round(CH * 0.075), 2, CH * 0.87, LABEL_W - 26);
    ctx.globalAlpha = 1;
    ctx.letterSpacing = '0px';
    // Divider.
    ctx.fillStyle = glow;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(LABEL_W, CH * 0.12, 3, CH * 0.76);
    ctx.globalAlpha = 1;

    // ── Digits ──
    const x0 = LABEL_W + 26;
    const cellW = (CW - x0 - 18) / DIGITS;
    const dw = cellW * 0.74;
    const dh = CH * 0.78;
    const dy = (CH - dh) / 2;
    for (let i = 0; i < DIGITS; i++) {
      const cx = x0 + cellW * i + (cellW - dw) / 2 + dw * 0.04;
      // Ghost segments: every bar faintly visible, like an unlit LCD.
      ctx.fillStyle = glow;
      ctx.globalAlpha = 0.085;
      segPath(ctx, 0b1111111, cx, dy, dw, dh);
      ctx.fill();
      ctx.globalAlpha = 1;
      const ch = this.text[i] ?? ' ';
      const was = this.prevText[i] ?? ' ';
      const changed = ch !== was && this.prevText !== '';
      const w = changed ? hot : 0;
      const drawDigit = (c: string, oy: number, alpha: number) => {
        const m = SEG[c];
        if (!m || alpha <= 0.01) return;
        ctx.save();
        ctx.beginPath();
        ctx.rect(cx - dw * 0.2, dy - 4, dw * 1.4, dh + 8);
        ctx.clip();
        ctx.globalAlpha = alpha;
        // Soft glow under the lit bars, then the bars (whiter while flashing).
        ctx.shadowColor = glow;
        ctx.shadowBlur = 18;
        ctx.fillStyle = hexCss(this.lit.clone().lerp(new THREE.Color(1, 1, 1), 0.5 * w));
        segPath(ctx, m, cx, dy + oy, dw, dh);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.restore();
      };
      if (changed && ease < 1) {
        // Roll: the old digit leaves upward, the new one rises into place.
        drawDigit(was, -ease * dh * 1.08, 1 - ease);
        drawDigit(ch, (1 - ease) * dh * 1.08, 0.35 + 0.65 * ease);
      } else {
        drawDigit(ch, 0, 1);
      }
    }
    // Glass sheen: a faint diagonal highlight across the top.
    const sheen = ctx.createLinearGradient(0, 0, CW * 0.25, CH);
    sheen.addColorStop(0, 'rgba(255,255,255,0.045)');
    sheen.addColorStop(0.4, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, CW, CH * 0.5);
    ctx.restore();
    if (this.tex) this.tex.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    this.display.material.dispose();
    this.tex?.dispose();
    if (this.ownsMaterial) this.material.dispose();
  }
}
