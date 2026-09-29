import * as THREE from 'three';

// Procedural canvas textures for the results podium — no image assets. Every
// helper returns textures the caller owns and must dispose. The expensive fixed
// ones (wall, floor, marble, brushed metal, glows) draw their canvas once per
// session and share it (cachedCanvas); prewarmPodiumTextures() draws them early.

export const PODIUM_FONT = '"Chakra Petch", "Geist", system-ui, sans-serif';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return [cv, cv.getContext('2d')!];
}

// A procedural canvas, drawn once per key for the session (the texture wrapping
// it is per caller; disposing that never touches the canvas).
const canvasCache = new Map<string, HTMLCanvasElement>();
function cachedCanvas(key: string, draw: () => HTMLCanvasElement): HTMLCanvasElement {
  let cv = canvasCache.get(key);
  if (!cv) {
    cv = draw();
    canvasCache.set(key, cv);
  }
  return cv;
}

function tex(cv: HTMLCanvasElement, srgb = true, aniso = 4): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  return t;
}

export function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// Brushed metal: long horizontal streaks over a base colour. `frame` adds the
// seam / rivet detailing used on the plinth body. Used as both map and bump.
export function brushedMetal(base: string, seed: number, opts: { streak?: number; frame?: boolean; size?: number } = {}) {
  const size = opts.size ?? 512;
  const cv = cachedCanvas(`bm:${base}:${seed}:${opts.streak ?? ''}:${opts.frame ? 1 : 0}:${size}`, () => {
    const [cv, c] = makeCanvas(size, size);
    const rnd = mulberry32(seed);
    c.fillStyle = base;
    c.fillRect(0, 0, size, size);
    // Soft vertical banding (anisotropic sheen).
    const g = c.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, 'rgba(255,255,255,0.10)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.10)');
    g.addColorStop(1, 'rgba(255,255,255,0.05)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    const streak = opts.streak ?? 0.11;
    for (let i = 0; i < size * 5; i++) {
      const y = rnd() * size;
      const x = rnd() * size;
      const len = size * (0.15 + rnd() * 0.7);
      c.strokeStyle = rnd() > 0.5 ? `rgba(255,255,255,${rnd() * streak})` : `rgba(0,0,0,${rnd() * streak * 1.4})`;
      c.lineWidth = rnd() > 0.85 ? 2 : 1;
      for (const ox of [0, -size]) {
        c.beginPath();
        c.moveTo(x + ox, y);
        c.lineTo(x + ox + len, y);
        c.stroke();
      }
    }
    if (opts.frame) {
      // Inset panel seam (dark groove + lit lip) and corner rivets.
      const m = size * 0.045;
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.65)';
      roundRectPath(c, m, m, size - m * 2, size - m * 2, 10);
      c.stroke();
      c.lineWidth = 1.5;
      c.strokeStyle = 'rgba(255,255,255,0.16)';
      roundRectPath(c, m + 3, m + 3, size - m * 2, size - m * 2, 10);
      c.stroke();
      for (const [rx, ry] of [
        [m * 2.1, m * 2.1],
        [size - m * 2.1, m * 2.1],
        [m * 2.1, size - m * 2.1],
        [size - m * 2.1, size - m * 2.1],
      ]) {
        const rg = c.createRadialGradient(rx - 2, ry - 2, 1, rx, ry, 7);
        rg.addColorStop(0, 'rgba(255,255,255,0.5)');
        rg.addColorStop(1, 'rgba(0,0,0,0.6)');
        c.fillStyle = rg;
        c.beginPath();
        c.arc(rx, ry, 6, 0, Math.PI * 2);
        c.fill();
      }
    }
    return cv;
  });
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Dark veined "marble" — used for the base step. Value-noise veins.
export function darkMarble(seed: number, size = 512) {
  const cv = cachedCanvas(`marble:${seed}:${size}`, () => {
    const [cv, c] = makeCanvas(size, size);
    const rnd = mulberry32(seed);
    const g = c.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#171d28');
    g.addColorStop(1, '#0e131b');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    for (let v = 0; v < 26; v++) {
      let x = rnd() * size;
      let y = rnd() * size;
      let a = rnd() * Math.PI * 2;
      c.strokeStyle = `rgba(190,215,255,${0.03 + rnd() * 0.08})`;
      c.lineWidth = 0.6 + rnd() * 1.6;
      c.beginPath();
      c.moveTo(x, y);
      for (let s = 0; s < 40; s++) {
        a += (rnd() - 0.5) * 0.9;
        x += Math.cos(a) * 12;
        y += Math.sin(a) * 12;
        c.lineTo(x, y);
      }
      c.stroke();
    }
    return cv;
  });
  const t = tex(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Stage floor: dark glossy tiles with hairline seams and a faint lit inlay.
export function stageFloor(seed: number, size = 1024) {
  const cv = cachedCanvas(`floor:${seed}:${size}`, () => {
    const [cv, c] = makeCanvas(size, size);
    const rnd = mulberry32(seed);
    c.fillStyle = '#0d121a';
    c.fillRect(0, 0, size, size);
    const n = 8;
    const cell = size / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const s = 0.02 + rnd() * 0.035;
        c.fillStyle = `rgba(150,180,230,${s})`;
        c.fillRect(i * cell + 2, j * cell + 2, cell - 4, cell - 4);
      }
    }
    c.strokeStyle = 'rgba(0,0,0,0.9)';
    c.lineWidth = 5;
    for (let k = 0; k <= n; k++) {
      c.beginPath();
      c.moveTo(k * cell, 0);
      c.lineTo(k * cell, size);
      c.moveTo(0, k * cell);
      c.lineTo(size, k * cell);
      c.stroke();
    }
    c.strokeStyle = 'rgba(90,200,255,0.10)';
    c.lineWidth = 1.5;
    for (let k = 0; k <= n; k++) {
      c.beginPath();
      c.moveTo(k * cell + 3, 0);
      c.lineTo(k * cell + 3, size);
      c.moveTo(0, k * cell + 3);
      c.lineTo(size, k * cell + 3);
      c.stroke();
    }
    return cv;
  });
  const t = tex(cv, true, 8);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// The engraved place numeral for a plinth front: a dark recess with a lit lip
// (map) and the glyph in the medal colour (emissive), plus a height map.
export function numeralPlate(n: number, medalHex: string, size = 256) {
  const font = `700 ${Math.round(size * 0.84)}px ${PODIUM_FONT}`;
  const mk = (draw: (c: CanvasRenderingContext2D) => void, fill: string) => {
    const [cv, c] = makeCanvas(size, size);
    c.fillStyle = fill;
    c.fillRect(0, 0, size, size);
    c.font = font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    draw(c);
    return cv;
  };
  const txt = String(n);
  const cy = size * 0.54;
  const map = mk((c) => {
    c.fillStyle = 'rgba(255,255,255,0.35)';
    c.fillText(txt, size / 2 + 2, cy + 3);
    c.fillStyle = '#04070b';
    c.fillText(txt, size / 2, cy);
  }, 'rgba(0,0,0,0)');
  const emissive = mk((c) => {
    c.shadowColor = medalHex;
    c.shadowBlur = size * 0.06;
    c.fillStyle = medalHex;
    c.globalAlpha = 0.9;
    c.fillText(txt, size / 2, cy);
  }, '#000');
  return { map: tex(map), emissive: tex(emissive) };
}

// Soft radial glow (additive sprites / floor pools / halo).
export function radialGlow(size = 256, stops: Array<[number, string]> = [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]) {
  const cv = cachedCanvas(`glow:${size}:${JSON.stringify(stops)}`, () => {
    const [cv, c] = makeCanvas(size, size);
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    c.fillStyle = g;
    c.fillRect(0, 0, size, size);
    return cv;
  });
  return tex(cv);
}

// The arena wall: dark panelled steel, a lit horizon band, vertical light strips
// and a vignette. Drawn wide; the mesh stretches it behind the stage.
export function arenaWall(seed: number, w = 2048, h = 768) {
  const cv = cachedCanvas(`wall:${seed}:${w}x${h}`, () => {
    const [cv, c] = makeCanvas(w, h);
    const rnd = mulberry32(seed);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0a1020');
    g.addColorStop(0.45, '#182238');
    g.addColorStop(0.78, '#0f1626');
    g.addColorStop(1, '#070a11');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // Big panel grid.
    const pw = w / 16;
    const ph = h / 6;
    for (let j = 0; j < 6; j++) {
      for (let i = 0; i < 16; i++) {
        c.fillStyle = `rgba(150,185,255,${0.012 + rnd() * 0.035})`;
        c.fillRect(i * pw + 3, j * ph + 3, pw - 6, ph - 6);
      }
    }
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 3;
    for (let i = 0; i <= 16; i++) {
      c.beginPath();
      c.moveTo(i * pw, 0);
      c.lineTo(i * pw, h);
      c.stroke();
    }
    for (let j = 0; j <= 6; j++) {
      c.beginPath();
      c.moveTo(0, j * ph);
      c.lineTo(w, j * ph);
      c.stroke();
    }
    // Horizon band glow behind the podium.
    const band = c.createLinearGradient(0, h * 0.5, 0, h * 0.82);
    band.addColorStop(0, 'rgba(60,150,255,0)');
    band.addColorStop(0.5, 'rgba(70,170,255,0.20)');
    band.addColorStop(1, 'rgba(60,150,255,0)');
    c.fillStyle = band;
    c.fillRect(0, h * 0.5, w, h * 0.32);
    // Lit horizontal strips.
    for (const [y, a] of [
      [h * 0.3, 0.55],
      [h * 0.335, 0.25],
    ] as const) {
      const sg = c.createLinearGradient(0, 0, w, 0);
      sg.addColorStop(0, 'rgba(60,200,255,0)');
      sg.addColorStop(0.5, `rgba(120,225,255,${a})`);
      sg.addColorStop(1, 'rgba(60,200,255,0)');
      c.fillStyle = sg;
      c.fillRect(0, y, w, 3);
    }
    // Side vignette.
    const v = c.createLinearGradient(0, 0, w, 0);
    v.addColorStop(0, 'rgba(0,0,0,0.75)');
    v.addColorStop(0.25, 'rgba(0,0,0,0)');
    v.addColorStop(0.75, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.75)');
    c.fillStyle = v;
    c.fillRect(0, 0, w, h);
    return cv;
  });
  const t = tex(cv);
  return t;
}

// Name plate: dark glass, chamfered corner, medal accent bar, rank chip, name,
// score. Drawn at 2x for a crisp read on hi-dpi.
export type PlateSpec = { name: string; place: number; score: number; accent: string; you: boolean };
export function namePlate(p: PlateSpec) {
  const W = 800;
  const H = 280;
  const [cv, c] = makeCanvas(W, H);
  const cut = 34;
  const shape = () => {
    c.beginPath();
    c.moveTo(8, 8);
    c.lineTo(W - 8 - cut, 8);
    c.lineTo(W - 8, 8 + cut);
    c.lineTo(W - 8, H - 8);
    c.lineTo(8 + cut, H - 8);
    c.lineTo(8, H - 8 - cut);
    c.closePath();
  };
  shape();
  const bg = c.createLinearGradient(0, 8, 0, H - 8);
  bg.addColorStop(0, 'rgba(22,30,46,0.92)');
  bg.addColorStop(1, 'rgba(7,10,17,0.92)');
  c.fillStyle = bg;
  c.fill();
  // Accent wash from the left.
  c.save();
  shape();
  c.clip();
  const wash = c.createLinearGradient(0, 0, W * 0.7, 0);
  wash.addColorStop(0, p.accent + '33');
  wash.addColorStop(1, p.accent + '00');
  c.fillStyle = wash;
  c.fillRect(0, 0, W, H);
  c.fillStyle = p.accent;
  c.fillRect(8, 8, 14, H);
  c.restore();
  shape();
  c.lineWidth = p.you ? 5 : 3;
  c.strokeStyle = p.you ? '#67e8f9' : p.accent + 'cc';
  c.stroke();
  // Name (big), then rank + score on the second line.
  const ord = ['1ST', '2ND', '3RD'][p.place - 1] ?? p.place + 'TH';
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  let nm = p.name;
  c.fillStyle = p.you ? '#cffafe' : '#ffffff';
  let fs = 104;
  c.font = '700 ' + fs + 'px ' + PODIUM_FONT;
  while (c.measureText(nm).width > W - 92 && fs > 52) {
    fs -= 4;
    c.font = '700 ' + fs + 'px ' + PODIUM_FONT;
  }
  if (c.measureText(nm).width > W - 92) nm = nm.slice(0, 10) + '…';
  c.fillText(nm, 52, 122);
  c.fillStyle = p.accent;
  c.font = '700 88px ' + PODIUM_FONT;
  c.fillText(ord, 52, 246);
  let x = 52 + c.measureText(ord).width + 22;
  c.fillStyle = 'rgba(255,255,255,0.3)';
  c.fillRect(x - 11, 178, 3, 68);
  c.fillStyle = '#fff';
  c.font = '700 88px ' + PODIUM_FONT;
  c.fillText(String(p.score), x, 246);
  x += c.measureText(String(p.score)).width + 12;
  c.fillStyle = 'rgba(255,255,255,0.5)';
  c.font = '600 52px ' + PODIUM_FONT;
  c.fillText(p.score === 1 ? 'FRAG' : 'FRAGS', x, 244);
  if (p.you) {
    c.textAlign = 'right';
    c.fillStyle = '#67e8f9';
    c.font = '700 52px ' + PODIUM_FONT;
    c.fillText('YOU', W - 44, 244);
  }
  return tex(cv, true, 8);
}

// The podium's fixed texture set, with the exact arguments podium.ts builds it
// from (keep the two in step): drawn one per task ahead of the results screen
// (at match load), so the podium only wraps cached canvases when it appears.
export const PODIUM_MEDAL_BASE = ['#b98a22', '#8d97a6', '#94592b']; // brushed cap tints
export const PODIUM_GLOW_STOPS: Array<[number, string]> = [
  [0, 'rgba(255,214,120,0.9)'],
  [0.4, 'rgba(255,190,90,0.22)'],
  [1, 'rgba(255,170,60,0)'],
];
export async function prewarmPodiumTextures(): Promise<void> {
  if (typeof document === 'undefined') return;
  const jobs: Array<() => THREE.Texture> = [
    () => arenaWall(7),
    () => stageFloor(11),
    () => darkMarble(3),
    () => brushedMetal('#262f3d', 21, { frame: true }),
    ...PODIUM_MEDAL_BASE.map((b, i) => () => brushedMetal(b, 40 + i, { streak: 0.16 })),
    () => radialGlow(256, PODIUM_GLOW_STOPS),
    () => radialGlow(128),
    () => radialGlow(64),
  ];
  for (const job of jobs) {
    job().dispose();
    await new Promise((r) => setTimeout(r, 0));
  }
}
