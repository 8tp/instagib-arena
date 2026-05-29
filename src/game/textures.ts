import * as THREE from 'three';

// Procedural, canvas-generated arena surface textures — no asset downloads, no
// per-map disposal (built once, cached at module scope and shared across every
// map + rebuild). Colours are baked into each texture, so materials use
// color: 0xffffff and let the map drive the tone.

export type ArenaTextures = {
  floor: THREE.Texture;
  wall: THREE.Texture;
  platform: THREE.Texture;
  cover: THREE.Texture;
  tower: THREE.Texture;
};

let cache: ArenaTextures | null = null;

function makeCanvas(size = 256): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

function finalize(canvas: HTMLCanvasElement, repeat: number): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  return tex;
}

// Light speckle to break up flat fills.
function speckle(ctx: CanvasRenderingContext2D, size: number, alpha: number, light: boolean) {
  ctx.save();
  for (let i = 0; i < size * size * 0.04; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const a = Math.random() * alpha;
    ctx.fillStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  ctx.restore();
}

function gridTexture(base: string, line: string, cells: number, repeat: number): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, 0.06, true);
  speckle(ctx, size, 0.05, false);
  const step = size / cells;
  ctx.strokeStyle = line;
  ctx.lineWidth = 2;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  return finalize(canvas, repeat);
}

// Vertical steel panels with seams + rivets.
function panelTexture(base: string, seam: string, repeat: number): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, 0.05, true);
  const panels = 4;
  const pw = size / panels;
  ctx.strokeStyle = seam;
  ctx.lineWidth = 3;
  for (let i = 0; i <= panels; i++) {
    const x = Math.round(i * pw) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
  // Horizontal mid band
  ctx.beginPath();
  ctx.moveTo(0, size / 2 + 0.5);
  ctx.lineTo(size, size / 2 + 0.5);
  ctx.stroke();
  // Rivets
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < panels; i++) {
    const cx = i * pw + pw / 2;
    for (const cy of [pw * 0.4, size - pw * 0.4]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return finalize(canvas, repeat);
}

// Shipping-container style: corrugated ribs + a couple of bolts.
function containerTexture(base: string, rib: string, repeat: number): THREE.Texture {
  const size = 256;
  const [canvas, ctx] = makeCanvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const ribs = 16;
  const rw = size / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * rw;
    ctx.fillStyle = i % 2 === 0 ? rib : 'rgba(255,255,255,0.07)';
    ctx.fillRect(x, 0, rw / 2, size);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  speckle(ctx, size, 0.08, false);
  return finalize(canvas, repeat);
}

export function getArenaTextures(): ArenaTextures {
  if (cache) return cache;
  cache = {
    floor: gridTexture('#6b7480', '#454c57', 8, 6),
    wall: panelTexture('#737d8c', '#4b5360', 2),
    platform: gridTexture('#8a93a2', '#5b636f', 4, 3),
    cover: containerTexture('#b06a3a', '#8a4f29', 1),
    tower: panelTexture('#5e6672', '#3f4651', 2),
  };
  return cache;
}
