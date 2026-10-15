import { apiFetch } from './backend';

type Response<T> = { success: boolean; data: T; message?: string };
type WavedashSdk = {
  init: () => boolean;
  updateLoadProgressZeroToOne: (progress: number) => void;
  getUserId: () => string;
  getUsername: () => string;
  getUserJwt: () => Promise<Response<string>>;
  getLaunchParams: () => Record<string, unknown>;
  copyLink: (url: string) => Promise<boolean>;
  requestStats: () => Promise<Response<unknown>>;
  setStat: (name: string, value: number, storeNow?: boolean) => boolean;
  setAchievement: (name: string, storeNow?: boolean) => boolean;
  storeStats: () => boolean;
  on: (event: 'StatsStored', listener: (payload: { success: boolean }) => void) => () => void;
  getOrCreateLeaderboard: (name: string, sort: number, display: number) => Promise<Response<{ id: string }>>;
  uploadLeaderboardScore: (id: string, score: number, keepBest: boolean) => Promise<Response<unknown>>;
};

export const wavedashBuild = import.meta.env.VITE_WAVEDASH === '1';
const sdk = () => (window as Window & { Wavedash?: WavedashSdk }).Wavedash;
let initialized = false;

// Railway room codes are custom launch data, separate from SDK lobby IDs.
// The public game URL lets each invitee receive their own frame and identity.
export function wavedashInviteLink(roomId: string): string | null {
  if (!wavedashBuild) return null;
  const url = new URL('https://wavedash.com/games/instagib-arena');
  url.searchParams.set('wvdsh_join', roomId);
  return url.href;
}

export function wavedashInviteCode(): string | null {
  if (!wavedashBuild) return null;
  const code = sdk()?.getLaunchParams().join;
  return typeof code === 'string' && /^[A-Z0-9]{3,10}$/i.test(code) ? code.toUpperCase() : null;
}

export async function copyWavedashLink(url: string): Promise<boolean> {
  if (!wavedashBuild) return false;
  const platform = sdk();
  if (!platform) throw new Error('Wavedash clipboard unavailable');
  if (!await platform.copyLink(url)) throw new Error('Wavedash could not copy the link');
  return true;
}

export function finishWavedashLoading(): void {
  const platform = sdk();
  if (!platform || initialized) return;
  initialized = true;
  platform.updateLoadProgressZeroToOne(1);
  platform.init();
}

export async function wavedashCredentials(): Promise<{ token: string; username: string } | null> {
  if (!wavedashBuild) return null;
  finishWavedashLoading();
  for (let i = 0; i < 80; i++) {
    const platform = sdk();
    if (platform?.getUserId()) {
      const response = await platform.getUserJwt();
      if (!response.success || typeof response.data !== 'string') throw new Error('Wavedash sign-in failed');
      return { token: response.data, username: platform.getUsername() };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const boards = [
  ['career-frags', 'totalKills'], ['career-wins', 'totalWins'], ['best-kill-streak', 'bestKillStreak'],
] as const;
const stats = {
  total_kills: 'totalKills', total_deaths: 'totalDeaths', total_games: 'totalGames',
  total_wins: 'totalWins', best_kill_streak: 'bestKillStreak', headshots: 'headshots',
} as const;
const achievements = [
  ['first_frag', 'totalKills', 1], ['first_win', 'totalWins', 1],
  ['centurion', 'totalKills', 100], ['rail_master', 'totalKills', 1000],
  ['unstoppable', 'bestKillStreak', 10],
] as const;
let syncing = false;
let lastBoardsSynced = '';
const boardIds = new Map<string, string>();

// Score writes use Wavedash's browser SDK. Source every value from our
// authenticated server totals, never client combat events. Platform failures
// retry on the next refresh and never block gameplay.
export async function syncWavedashCareer(): Promise<void> {
  const platform = sdk();
  if (!wavedashBuild || !platform || !platform.getUserId() || syncing) return;
  syncing = true;
  try {
    const [accountResponse, statsResponse] = await Promise.all([apiFetch('/api/auth/me'), apiFetch('/api/stats')]);
    if (!accountResponse.ok || !statsResponse.ok) return;
    const account = await accountResponse.json() as { user?: { wavedashUserId?: string } };
    if (account.user?.wavedashUserId !== platform.getUserId()) return;
    const { stats: career } = await statsResponse.json() as { stats: Record<string, number> };
    const signature = JSON.stringify(career);
    const loaded = await platform.requestStats();
    if (!loaded.success) return;
    let accepted = true;
    for (const [identifier, field] of Object.entries(stats)) {
      const value = career[field];
      if (!Number.isFinite(value) || value < 0) return;
      if (!platform.setStat(identifier, value)) accepted = false;
    }
    for (const [identifier, field, threshold] of achievements) {
      if (career[field] >= threshold && !platform.setAchievement(identifier)) accepted = false;
    }
    if (!accepted || !platform.storeStats()) return;
    if (signature === lastBoardsSynced) return;
    for (const [name, field] of boards) {
      if (career[field] <= 0) continue;
      let id = boardIds.get(name);
      if (!id) {
        const board = await platform.getOrCreateLeaderboard(name, 1, 0);
        if (!board.success) return;
        id = board.data.id;
        boardIds.set(name, id);
      }
      const posted = await platform.uploadLeaderboardScore(id, career[field], true);
      if (!posted.success) return;
    }
    lastBoardsSynced = signature;
  } catch { /* Keep the game usable during platform outages. */ }
  finally { syncing = false; }
}

export function watchWavedashSaves(onResult: (success: boolean) => void): () => void {
  return sdk()?.on('StatsStored', (payload) => onResult(payload.success)) ?? (() => {});
}
