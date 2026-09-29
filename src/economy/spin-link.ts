// Tiny glue between the main menu's FREE SPIN pip and the Locker's Spin tab.
export const SPIN_TAB_KEY = 'ig-locker-tab'; // sessionStorage: 'spin' → the Locker opens on the Spin tab
export const SPIN_USED_EVENT = 'ig-spin-used'; // window event: today's free spin was taken (hide the pip)

// Visual weights: never below `min` of the wheel, then renormalised to 360°.
export function visualWeights(pcts: number[], min = 0.06): number[] {
  const w = pcts.map((p) => Math.max(p, min));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / sum);
}
