// Admin console data layer: typed GETs for the metrics endpoints (server/db.ts +
// server/admin-metrics.ts) and the player search. Mutations stay on `econ`
// (src/economy/api.ts). Every route is under /api/admin (requireAdmin).
import { useEffect, useState } from 'react';
import type { Tier } from '../game/items/types';
import { econ, mockOn } from '../economy/api';

export type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: T };

export async function getJSON<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 403) return { ok: false, message: 'Your session is not an admin session. Sign in again.' };
    if (!r.ok) return { ok: false, message: `The server answered ${r.status}.` };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, message: 'Can’t reach the server. Check your connection and retry.' };
  }
}

export async function postJSON<T>(url: string, body: object): Promise<T | null> {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// Fetch-on-change with a retry handle. `key` changes refetch; stale responses are dropped.
export function useLoad<T>(url: string | null, pick: (raw: unknown) => T): Load<T> & { retry: () => void } {
  const [res, setRes] = useState<{ url: string | null; n: number; load: Load<T> }>({ url, n: 0, load: { state: 'loading' } });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    void getJSON<unknown>(url).then((r) => {
      if (!live) return;
      setRes({ url, n, load: r.ok ? { state: 'ok', data: pick(r.data) } : { state: 'error', message: r.message } });
    });
    return () => {
      live = false;
    };
    // `pick` is a stable accessor at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, n]);
  const load: Load<T> = res.url === url && res.n === n ? res.load : { state: 'loading' };
  return { ...load, retry: () => setN((x) => x + 1) };
}

// ── Shapes (mirror the server) ──────────────────────────────────────────────
export type MetricsWindow = { matches: number; activePlayers: number; newAccounts: number; logins: number };
export type Overview = {
  totalAccounts: number;
  playersWithGames: number;
  totalMatches: number;
  onlineMatches: number;
  totalKills: number;
  totalDeaths: number;
  globalAccuracy: number;
  totalXp: number;
  avgLifetimeDays: number;
  stickiness: number;
  windows: { day: MetricsWindow; week: MetricsWindow; month: MetricsWindow };
};
export type LiveCounts = { online: number; inMatch: number; rooms: number };
export type Cohort = { date: string; size: number; d1: number; d7: number };
export type WeekCohort = { start: string; size: number; active: number[] };
export type MatchRow = {
  id: number;
  ts: number;
  playerId: string;
  playerName: string;
  kills: number;
  deaths: number;
  won: boolean;
  headshots: number;
  accuracy: number;
  offline: boolean;
  xp: number;
  credits?: number | null;
  durationMs?: number | null;
  partial?: boolean;
  mode: string | null;
};
export type PlayerRow = {
  id: string;
  userName: string;
  level: number;
  totalGames: number;
  totalKills: number;
  totalDeaths: number;
  headshots: number;
  bestAccuracy: number;
  totalXp: number;
  credits: number;
  kd: number;
  lastSeen: number;
  createdAt: number;
  admin: boolean;
  verified: boolean;
};
export type EconFlows = {
  faucet: number;
  sink: number;
  matchPayout: number;
  salvage: number;
  rewards: number;
  grants: number;
  caseSpend: number;
  listingFees: number;
  saleTax: number;
  caseOpens: number;
  marketSales: number;
  marketVolume: number;
  trades: number;
  minted: number;
};
export type EconDay = EconFlows & { date: string; cases: Record<string, number> };
export type EconomyMetrics = {
  days: number;
  held: { credits: number; rolls: number; holders: number; items: number; listed: number; anomalous: number; tracked: number; killstreak: number; festive: number; staffMade: number };
  cur: EconFlows;
  prev: EconFlows;
  series: EconDay[];
  mintedByOrigin: { origin: string; n: number }[];
  mintedByTier: { tier: Tier; n: number }[];
  heldByTier: { tier: Tier; n: number }[];
  topHeld: { def: string; n: number; anomalous: number }[];
};
export type EngagementTotals = { matches: number; onlineMatches: number; guestMatches: number; players: number; newAccounts: number; logins: number };
export type EngagementDay = { date: string; dau: number; matches: number; guest: number; newAccounts: number; modes: Record<string, number> };
export type EngagementMetrics = {
  days: number;
  dau: number;
  wau: number;
  mau: number;
  cur: EngagementTotals;
  prev: EngagementTotals;
  series: EngagementDay[];
  modes: { mode: string; n: number }[];
  hours: number[];
  topPlayers: { id: string; name: string; matches: number; wins: number; kills: number; deaths: number }[];
  length: MatchLength;
};
export type MatchLength = {
  measured: number;
  avgMs: number | null;
  prevAvgMs: number | null;
  buckets: { label: string; n: number }[];
  byMode: { mode: string; n: number; avgMs: number }[];
};
export type ConcurrencySample = { ts: number; online: number; inMatch: number; rooms: number };
export type Concurrency = { since: number; hours: number; samples: ConcurrencySample[]; peak: ConcurrencySample | null; peak24h: ConcurrencySample | null };
export type WeeklyChallengeStats = {
  week: string;
  participants: number;
  runs: number;
  winners: number;
  bestTimeMs: number;
  topKills: number;
  replaysStored: number;
  replayBytes: number;
  map: string;
  fragLimit: number;
};

// ── Players (combobox) ──────────────────────────────────────────────────────
export type AdminPlayer = {
  id: string;
  userName: string;
  level: number;
  admin: boolean;
  verified: boolean;
  createdAt: number;
  lastSeen: number;
  credits: number;
  freeRolls: number;
  items: number;
  games: number;
  kills: number;
  deaths: number;
  wins: number;
};

// Typeahead. In the economy mock (?mockEconomy=1) there is no admin search
// endpoint, so fall back to the mock's player list with zeroed stats.
export async function searchPlayers(q: string, limit = 20): Promise<{ ok: true; players: AdminPlayer[] } | { ok: false; message: string }> {
  if (mockOn()) {
    const r = await econ.adminFindPlayers(q);
    if (!r.ok) return { ok: false, message: 'Search failed.' };
    return {
      ok: true,
      players: r.players.map((p) => ({ id: p.id, userName: p.userName, level: p.level, admin: !!p.admin, verified: false, createdAt: 0, lastSeen: p.lastSeen, credits: 0, freeRolls: 0, items: 0, games: 0, kills: 0, deaths: 0, wins: 0 })),
    };
  }
  const r = await getJSON<{ players: AdminPlayer[] }>(`/api/admin/players/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return r.ok ? { ok: true, players: r.data.players } : r;
}

export async function playerCard(key: string): Promise<AdminPlayer | null> {
  if (mockOn()) {
    const r = await searchPlayers(key, 1);
    return r.ok ? (r.players[0] ?? null) : null;
  }
  const r = await getJSON<{ player: AdminPlayer }>(`/api/admin/players/${encodeURIComponent(key)}/card`);
  return r.ok ? r.data.player : null;
}
