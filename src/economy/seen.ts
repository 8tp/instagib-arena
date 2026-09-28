// "NEW" tracking for inventory instances. The seen set lives in localStorage
// per account; the very first visit baselines everything already owned (no
// wall of NEW badges).
const KEY = 'instagib-econ-seen:';

export function loadSeen(owner: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(KEY + owner);
    if (!raw) return null;
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? new Set(arr.filter((x): x is string => typeof x === 'string')) : null;
  } catch {
    return null;
  }
}

export function saveSeen(owner: string, seen: ReadonlySet<string>): void {
  try {
    localStorage.setItem(KEY + owner, JSON.stringify([...seen].slice(-2000)));
  } catch {
    /* storage blocked — NEW badges just reset next visit */
  }
}
