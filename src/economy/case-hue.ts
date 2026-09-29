// Each case's hue: `a` the lit colour (and the light leaking from the lid
// when a crate cracks open), `b` the shaded one.
import type { CaseId } from '../game/items/types';

export const CASE_HUE: Record<CaseId, { a: string; b: string }> = {
  hat: { a: '#f59e0b', b: '#5a2f04' },
  weapon: { a: '#ef4444', b: '#4a0d0d' },
  accessory: { a: '#4b8dff', b: '#0d2452' },
  taunt: { a: '#a855f7', b: '#2d0c4e' },
  vault: { a: '#ff4fd8', b: '#1d0a3a' },
};
