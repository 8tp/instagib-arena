import * as THREE from 'three';

// ── Sprite atlas for the unusual particles ───────────────────────────────────
// One 256² canvas, 4×4 cells of 64 px, white shapes on transparent (the
// particle colour tints them). Every shape stays inside the cell's inscribed
// circle (≤ 0.44 of the cell) so a rotated point sprite never shows a
// neighbour's edge. Built once, module-cached, shared by every wearer.

export const CELL = {
  glow: 0, // soft radial
  dot: 1, // hard spark: bright core, short falloff
  star: 2, // 4-point sparkle
  heart: 3,
  zero: 4, // glyph "0"
  one: 5, // glyph "1"
  flame: 6, // teardrop tongue, point up
  puff: 7, // lumpy cloud puff (normal blending)
  streak: 8, // thin vertical line (rain)
  wisp: 9, // tall soft ellipse
  diamond: 10, // faceted gem
  ring: 11, // thin soft ring
} as const;

const N = 4;
const C = 64;

let atlas: THREE.Texture | null = null;

export function unusualAtlas(): THREE.Texture {
  if (atlas) return atlas;
  if (typeof document === 'undefined') {
    atlas = new THREE.Texture();
    return atlas;
  }
  const cv = document.createElement('canvas');
  cv.width = cv.height = N * C;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const cell = (i: number, draw: (cx: number, cy: number) => void) => {
    const x = (i % N) * C;
    const y = Math.floor(i / N) * C;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, C, C);
    ctx.clip();
    draw(x + C / 2, y + C / 2);
    ctx.restore();
  };
  const radial = (cx: number, cy: number, r: number, stops: [number, number][]) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, a] of stops) g.addColorStop(o, `rgba(255,255,255,${a})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };

  cell(CELL.glow, (cx, cy) => radial(cx, cy, 28, [[0, 1], [0.2, 0.7], [0.5, 0.22], [0.8, 0.05], [1, 0]]));
  cell(CELL.dot, (cx, cy) => radial(cx, cy, 20, [[0, 1], [0.25, 0.95], [0.5, 0.35], [1, 0]]));
  cell(CELL.star, (cx, cy) => {
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      const len = 27;
      const w = 3.2;
      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a + Math.PI / 2) * w, cy + Math.sin(a + Math.PI / 2) * w);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.lineTo(cx + Math.cos(a - Math.PI / 2) * w, cy + Math.sin(a - Math.PI / 2) * w);
      ctx.closePath();
      ctx.fill();
    }
    radial(cx, cy, 10, [[0, 1], [0.4, 0.6], [1, 0]]);
    ctx.globalCompositeOperation = 'source-over';
  });
  cell(CELL.heart, (cx, cy) => {
    const heart = (s: number) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + 16 * s);
      ctx.bezierCurveTo(cx - 26 * s, cy + 0 * s, cx - 20 * s, cy - 22 * s, cx, cy - 10 * s);
      ctx.bezierCurveTo(cx + 20 * s, cy - 22 * s, cx + 26 * s, cy + 0 * s, cx, cy + 16 * s);
      ctx.closePath();
    };
    // Neon heart: soft outer glow, filled body, a hot rim.
    ctx.shadowColor = 'rgba(255,255,255,0.9)';
    ctx.shadowBlur = 8;
    heart(1);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,1)';
    heart(0.94);
    ctx.stroke();
    // Glint.
    radial(cx - 8, cy - 8, 6, [[0, 1], [1, 0]]);
  });
  const glyph = (ch: string) => (cx: number, cy: number) => {
    ctx.font = 'bold 40px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.shadowBlur = 7;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillText(ch, cx, cy + 2);
    ctx.shadowBlur = 0;
    ctx.fillText(ch, cx, cy + 2);
  };
  cell(CELL.zero, glyph('0'));
  cell(CELL.one, glyph('1'));
  cell(CELL.flame, (cx, cy) => {
    // A soft licking tongue: stacked soft discs, wide + dense at the root,
    // narrowing and thinning toward a wavering tip. No hard outline (a crisp
    // teardrop reads as a water drop).
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 9; k++) {
      const u = k / 8;
      const y = cy + 16 - u * 40;
      const x = cx + Math.sin(u * 3.2) * 3 * u;
      const r = 13 * (1 - u * 0.78);
      radial(x, y, r, [[0, 0.34 * (1 - u * 0.55)], [0.5, 0.18 * (1 - u * 0.5)], [1, 0]]);
    }
    ctx.globalCompositeOperation = 'source-over';
  });
  cell(CELL.puff, (cx, cy) => {
    const lumps: [number, number, number][] = [
      [0, 3, 18], [-12, 6, 13], [12, 6, 13], [-6, -7, 13], [8, -6, 12], [0, 12, 12],
    ];
    for (const [dx, dy, r] of lumps) radial(cx + dx, cy + dy, r, [[0, 0.95], [0.55, 0.8], [1, 0]]);
  });
  cell(CELL.streak, (cx, cy) => {
    const g = ctx.createLinearGradient(cx, cy - 26, cx, cy + 26);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 1.5, cy - 26, 3, 52);
  });
  cell(CELL.wisp, (cx, cy) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(0.42, 1);
    radial(0, 0, 27, [[0, 0.6], [0.3, 0.32], [0.65, 0.1], [1, 0]]);
    ctx.restore();
  });
  cell(CELL.diamond, (cx, cy) => {
    ctx.shadowColor = 'rgba(255,255,255,1)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 22);
    ctx.lineTo(cx + 13, cy);
    ctx.lineTo(cx, cy + 22);
    ctx.lineTo(cx - 13, cy);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - 22);
    ctx.lineTo(cx + 5, cy);
    ctx.lineTo(cx, cy + 22);
    ctx.lineTo(cx - 5, cy);
    ctx.closePath();
    ctx.fill();
  });
  cell(CELL.ring, (cx, cy) => {
    const g = ctx.createRadialGradient(cx, cy, 14, cx, cy, 27);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 27, 0, Math.PI * 2);
    ctx.fill();
  });

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace; // white shapes; the alpha carries the form
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  atlas = t;
  return t;
}
