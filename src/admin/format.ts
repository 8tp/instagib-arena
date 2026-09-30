// Number / time formatting for the admin console.

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

// 1,284 · 12.9K · 4.2M — for tile values and axis ticks.
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a < 10_000) return fmt(n);
  if (a < 1_000_000) return `${(n / 1000).toFixed(a < 100_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export const pct = (x: number, digits = 0): string => `${(x * 100).toFixed(digits)}%`;

export function ago(ts: number, now = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 60) return `${Math.floor(d)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const shortDate = (ts: number): string => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

// ISO YYYY-MM-DD → "Sep 14"
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Change vs a previous period, as a fraction (null when there's no baseline).
export function change(cur: number, prev: number): number | null {
  if (prev === 0) return cur === 0 ? 0 : null;
  return (cur - prev) / prev;
}

// mm:ss.s clear time for the weekly speedrun (0 = no winning run).
export function fmtClear(ms: number): string {
  if (ms <= 0) return '—';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rem = (s - m * 60).toFixed(1);
  return m > 0 ? `${m}:${rem.padStart(4, '0')}` : `${rem}s`;
}

export const fmtBytes = (b: number): string => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`);

// A stable accent for a player's avatar initial (hash → one of a few hues).
const AVATAR = ['#5be3ff', '#f3c152', '#3fd69a', '#d58cff', '#ff8a6b', '#8fb4ff'];
export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR[Math.abs(h) % AVATAR.length];
}
