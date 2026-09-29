// Daily free case — shared bits for the Cases tab and the menu's FREE CASE pip.
export const DAILY_CASE_USED_EVENT = 'ig:daily-case-used';
// sessionStorage hint: the menu pip opens the Locker straight on the Cases tab.
export const LOCKER_TAB_KEY = 'ig.locker.tab';

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}
