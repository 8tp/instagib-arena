import * as THREE from 'three';
import type { Character } from './character/character';
import { clipTime, ease, evalProp, type Clip, type ClipProp, type PropKind } from './character/clip';
import { fxFlags } from './fx/fx-settings';

// ── Emote props ──────────────────────────────────────────────────────────────
//
// Small hard-light objects an emote clip can conjure (clip.ts `props`): the
// "L" glyph on the forehead, a GG picket sign, a mic to drop, a teacup. The
// suit materialises them, so they're emissive holograms — no lighting, no
// shadows, one draw call per piece.
//
// CharacterAnimator owns one EmoteProps per combatant (created on the first
// clip that has props), so every surface that plays emotes — taunts, bots,
// the Locker, the menu hero, thumbnails, replays — gets them for free. Each
// prop rides a bone (the bones are flat children of the character root, so a
// child object inherits the bone's model transform) and is shown only inside
// its clip window while the emote's blend weight is above ½.
//
// Cost: geometry, textures and materials are module-level caches shared by
// every combatant (tagged userData.shared so Game.disposeScene() skips them);
// a combatant only owns a few Object3D/Mesh wrappers. Purely visual.

type Parts = { geo: Record<string, THREE.BufferGeometry>; mat: Record<string, THREE.MeshBasicMaterial> };
let parts: Parts | null = null;

// HDR hard-light colours (toneMapped:false → the bloom pass picks them out).
const L_COL = new THREE.Color(1.25, 2.1, 0.55);
const SIGN_COL = new THREE.Color(0.55, 1.7, 2.2);
const MIC_COL = new THREE.Color(0.9, 1.5, 2.2);
const MIC_HEAD = new THREE.Color(1.8, 1.9, 2.1);
const TEA_COL = new THREE.Color(2.0, 1.65, 1.1);

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return [cv, cv.getContext('2d')!];
}

function tex(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// Faint hologram scanlines over whatever is already drawn.
function scanlines(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 2);
  ctx.globalCompositeOperation = 'source-over';
}

// The "L": a fat glowing stroke with a white-hot core. White on transparent;
// the material colour tints it.
function glyphTexture(): THREE.CanvasTexture {
  const [cv, ctx] = canvas(256, 256);
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(78, 34);
    ctx.lineTo(78, 206);
    ctx.lineTo(196, 206);
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 26;
  ctx.lineWidth = 58;
  path();
  ctx.stroke();
  ctx.shadowBlur = 10;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 36;
  path();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 16;
  path();
  ctx.stroke();
  scanlines(ctx, 256, 256);
  return tex(cv);
}

// The GG board: a translucent panel, bright frame, big "GG".
function signTexture(): THREE.CanvasTexture {
  const [cv, ctx] = canvas(512, 320);
  const r = 34;
  const box = (x: number, y: number, w: number, h: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  };
  ctx.fillStyle = 'rgba(40,120,170,0.55)';
  box(14, 14, 484, 292);
  ctx.fill();
  ctx.lineWidth = 14;
  ctx.strokeStyle = 'rgba(210,245,255,0.95)';
  ctx.shadowColor = 'rgba(160,230,255,1)';
  ctx.shadowBlur = 18;
  box(20, 20, 472, 280);
  ctx.stroke();
  ctx.font = '900 210px "Arial Black", Impact, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('GG', 256, 172);
  ctx.shadowBlur = 0;
  scanlines(ctx, 512, 320);
  return tex(cv);
}

function hardLight(color: THREE.Color, opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    toneMapped: false,
    ...opts,
  });
}

function getParts(): Parts {
  if (parts) return parts;
  // Planes face −Z (the character's forward) so text reads from the front.
  const glyph = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI);
  const board = new THREE.PlaneGeometry(0.6, 0.375).rotateY(Math.PI).translate(0, 0.62, 0);
  const stick = new THREE.BoxGeometry(0.026, 0.56, 0.026).translate(0, 0.2, 0);
  const micBody = new THREE.CylinderGeometry(0.024, 0.016, 0.17, 12).translate(0, 0.04, 0);
  const micBand = new THREE.CylinderGeometry(0.029, 0.029, 0.018, 12).translate(0, 0.13, 0);
  const micHead = new THREE.SphereGeometry(0.043, 14, 10).translate(0, 0.165, 0);
  // Teacup: a lathed bowl (open top) + a half-torus handle.
  const prof = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.034, 0.0),
    new THREE.Vector2(0.04, 0.012),
    new THREE.Vector2(0.05, 0.05),
    new THREE.Vector2(0.056, 0.082),
    new THREE.Vector2(0.052, 0.082),
  ];
  const cup = new THREE.LatheGeometry(prof, 16);
  const handle = new THREE.TorusGeometry(0.022, 0.006, 6, 10, Math.PI).rotateZ(-Math.PI / 2).translate(0.052, 0.045, 0);
  const saucer = new THREE.CylinderGeometry(0.1, 0.06, 0.014, 20);
  const glyphMat = hardLight(L_COL, { map: glyphTexture(), blending: THREE.AdditiveBlending, side: THREE.DoubleSide, opacity: 1 });
  const signMat = hardLight(new THREE.Color(1.35, 1.35, 1.35), { map: signTexture(), side: THREE.DoubleSide, opacity: 1 });
  parts = {
    geo: { glyph, board, stick, micBody, micBand, micHead, cup, handle, saucer },
    mat: {
      glyph: glyphMat,
      sign: signMat,
      stick: hardLight(SIGN_COL),
      mic: hardLight(MIC_COL),
      micHead: hardLight(MIC_HEAD, { opacity: 0.85 }),
      tea: hardLight(TEA_COL, { side: THREE.DoubleSide, opacity: 0.88 }),
    },
  };
  return parts;
}

function mesh(geo: string, mat: string): THREE.Mesh {
  const p = getParts();
  const m = new THREE.Mesh(p.geo[geo], p.mat[mat]);
  m.castShadow = false;
  m.receiveShadow = false;
  m.userData.shared = true; // geometry + material belong to the module cache
  m.renderOrder = 2;
  return m;
}

// A fresh (cheap) instance of a prop: wrappers around the shared parts.
// Origin = the grip / attachment point; the clip keys place it on the bone.
function buildProp(kind: PropKind): THREE.Object3D {
  const g = new THREE.Group();
  switch (kind) {
    case 'glyphL':
      g.add(mesh('glyph', 'glyph'));
      break;
    case 'ggSign':
      g.add(mesh('stick', 'stick'), mesh('board', 'sign'));
      break;
    case 'mic':
      g.add(mesh('micBody', 'mic'), mesh('micBand', 'micHead'), mesh('micHead', 'micHead'));
      break;
    case 'teacup':
      g.add(mesh('cup', 'tea'), mesh('handle', 'tea'));
      break;
    case 'saucer':
      g.add(mesh('saucer', 'tea'));
      break;
  }
  g.userData.shared = true;
  return g;
}

// Hologram shimmer on the shared materials, once per frame for everyone.
// Reduced effects: steady (no flicker).
let lastFlicker = -1;
function flicker(): void {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  if (now - lastFlicker < 8 || !parts) return;
  lastFlicker = now;
  const m = parts.mat;
  if (fxFlags.reduced) {
    m.glyph.opacity = m.sign.opacity = 1;
    return;
  }
  const t = now / 1000;
  const n = 0.5 + 0.5 * Math.sin(t * 23.0) * Math.sin(t * 7.3 + 1.7);
  const k = 0.9 + 0.1 * n;
  m.glyph.opacity = k;
  m.sign.opacity = 0.94 + 0.06 * n;
}

const _p = [0, 0, 0];
const _r = [0, 0, 0];

export class EmoteProps {
  private clip: Clip | null = null;
  private objs: THREE.Object3D[] = [];
  // Instances are kept per clip-prop so replaying an emote allocates nothing.
  private readonly cache = new Map<ClipProp, THREE.Object3D>();

  constructor(private readonly character: Character) {}

  // Pose + show the current clip's props. `t` = emote time (s), `w` = blend
  // weight. A null clip (or a hidden body) detaches everything.
  update(clip: Clip | null, t: number, w: number): void {
    if (clip !== this.clip) this.setClip(clip);
    if (!clip || this.objs.length === 0) return;
    if (w <= 0.5) {
      for (const o of this.objs) o.visible = false;
      return;
    }
    flicker();
    // Materialise with the blend: 0.5 → 0.8 weight pops the prop in.
    const wk = ease('outBack', Math.min(1, (w - 0.5) / 0.3));
    const tt = clipTime(clip, t);
    for (let i = 0; i < this.objs.length; i++) {
      const o = this.objs[i];
      const s = evalProp(clip, clip.props[i], tt, _p, _r) * wk;
      o.visible = s > 0.002;
      if (!o.visible) continue;
      o.position.set(_p[0], _p[1], _p[2]);
      o.rotation.set(_r[0], _r[1], _r[2], 'YXZ');
      o.scale.setScalar(s);
    }
  }

  hide(): void {
    for (const o of this.objs) o.visible = false;
  }

  private setClip(clip: Clip | null): void {
    for (const o of this.objs) o.removeFromParent();
    this.objs = [];
    this.clip = clip;
    if (!clip) return;
    const bones = this.character.rig.bones;
    for (const p of clip.props) {
      let o = this.cache.get(p);
      if (!o) {
        o = buildProp(p.kind);
        this.cache.set(p, o);
      }
      o.visible = false;
      bones[p.bone].add(o);
      this.objs.push(o);
    }
  }

  // Detach every instance (the shared parts stay cached for the next body).
  dispose(): void {
    this.setClip(null);
    this.cache.clear();
  }
}
