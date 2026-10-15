import { apiFetch } from './backend';
import { wavedashBuild } from './wavedash';

// Coarse player-journey steps for the admin funnel (server/telemetry.ts).
// Fire-and-forget: a failed report never touches gameplay.
export type FunnelStep = 'menu' | 'match_start' | 'practice_start';
export type FunnelMode = 'online' | 'solo' | 'training' | 'challenge' | 'spectate';

let menuReported = false;

export function trackStep(step: FunnelStep, mode?: FunnelMode): void {
  if (step === 'menu') {
    if (menuReported) return; // once per page load
    menuReported = true;
  }
  apiFetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ step, mode, src: wavedashBuild ? 'wavedash' : 'web' }),
    keepalive: true,
  }).catch(() => {});
}
