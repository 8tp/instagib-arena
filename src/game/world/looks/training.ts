// Look for the 'training' arena: surface recipes, light rig, sky and dressing.
import { METAL, norm, type WorldTheme } from '../theme-kit';
import { R, bake, corrugationField, panel, unusedCeiling } from '../../textures';

// Lab: clean and bright — the exception to the moody rule.
const TEXTURES: WorldTheme['textures'] = {
  floor: () => panel(0x868c94, 4, { inset: 11, rough: 0.5, seed: 12 }),
  wall: () => panel(0xa9aeb5, 4, { cols: 2, rows: 1, midSeam: 0.4, rough: 0.55, seed: 24 }),
  ceiling: unusedCeiling,
  platform: () => panel(0x9aa0a8, 2, { rivets: 'corners', rivetInset: 16, rivetR: 2.5, rivetH: 1.2, rough: 0.45, seed: 42 }),
  cover: () => bake(
    corrugationField({ size: R, ribs: 8, depth: 5, frame: 14, frameDepth: 6, wobble: 0.5, seed: 53 }),
    {
      base: 0xa8683a, seamDark: 0.82, toneNoise: 0.04, grain: 0.02,
      rough: { base: 0.6, seam: 0.15, centre: 0, blotch: 0.08, grain: 0.03 },
      ao: 0.5, aoBlur: 5, seed: 54,
    },
    2,
  ),
  tower: () => panel(0x646b75, 4, { rivets: 'corners', rivetInset: 14, rivetR: 3, rivetH: 1.5, seed: 68 }),
};

// ── Training → Lab: clean, bright, neutral (the exception) ─────────────────
export const LAB: WorldTheme = {
  id: 'lab',
  textures: TEXTURES,
  openSky: true,
  slots: METAL,
  trim: { color: null, intensity: 1.9 },
  dress: {
    slot: 'tower', tint: 0xf4f4f4,
    crown: { h: 0.5, d: 0.1 },
    baseboard: { h: 0.35, d: 0.08 },
    collars: { h: 0.5, d: 0.1 },
    edges: { h: 0.12, d: 0.03 },
  },
  lights: [],
  bake: {
    ambientUp: 0xd8e0ea, ambientDown: 0x9aa0a8, ambient: 0.45,
    sky: { color: 0xb8d0ec, intensity: 1.0 },
    ao: { radius: 2.2, strength: 0.7 },
    sunShadow: true, sunIgnorePerimeter: true, sunIgnoreCeiling: false,
    texel: 0.45,
  },
  sun: { dir: norm([0.35, 0.85, 0.4]), color: 0xfff4e4, intensity: 2.0, mapScale: 1.0 },
  hemi: { sky: 0xcfe2f2, ground: 0x7d8088, intensity: 0.6, mapScale: 0.2 },
  fill: { dir: norm([-0.6, 0.35, -0.5]), color: 0x88a6ff, intensity: 0.35, mapScale: 0.4 },
  env: { intensity: 0.4, mapScale: 0.8 },
  worldSaturation: 1.0,
  exposure: 0.95,
  fog: { color: 0xb6cadb, near: 90, far: 280 },
  background: 0x9fc0dd,
  sky: { mode: 'lab', top: 0x2f6fb8, horizon: 0xc8dcec },
};
