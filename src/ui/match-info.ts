// Match facts the HUD, the Tab scoreboard and the loading screen derive from
// existing state (HudState + the match config) — no engine changes needed.

import {
  DUEL_FRAG_LIMIT,
  MATCH_FRAG_LIMIT,
  RANKED_DUEL_FRAG_LIMIT,
  TDM_FRAG_LIMIT,
  TEAM_NAMES,
  WEEKLY_CHALLENGE_FRAG_LIMIT,
  type GameMode,
} from '../game/constants';
import { MAPS } from '../game/map';
import type { PlayerScore } from '../game/types';

export type MatchFlavor = {
  mode: GameMode;
  training?: boolean;
  challenge?: boolean;
  ranked?: boolean;
};

// The frag limit the match is played to (null = endless training). Mirrors the
// engine's own limit resolution (game.ts checkMatchEnd / updateMatchDrama).
export function fragLimitFor(f: MatchFlavor): number | null {
  if (f.training) return null;
  if (f.mode === 'tdm') return TDM_FRAG_LIMIT;
  if (f.mode === 'duel') return f.ranked ? RANKED_DUEL_FRAG_LIMIT : DUEL_FRAG_LIMIT;
  return f.challenge ? WEEKLY_CHALLENGE_FRAG_LIMIT : MATCH_FRAG_LIMIT;
}

export function modeTitle(f: MatchFlavor): string {
  if (f.training) return 'Training range';
  if (f.challenge) return 'Weekly challenge';
  if (f.mode === 'tdm') return 'Team deathmatch';
  if (f.mode === 'duel') return f.ranked ? 'Ranked duel' : 'Duel';
  return 'Free-for-all';
}

// "Free-for-all · first to 25 frags"
export function modeLine(f: MatchFlavor): string {
  const limit = fragLimitFor(f);
  if (limit == null) return `${modeTitle(f)} · free practice`;
  return `${modeTitle(f)} · first to ${limit} ${f.mode === 'tdm' ? 'team frags' : 'frags'}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export type Standing = {
  place: number; // 1-based, shared on ties
  tied: boolean;
  frags: number;
  of: number; // players on the board
  leaderFrags: number; // best OTHER player's frags
  leaderName: string;
};

// Your standing on an already-sorted scoreboard (engine sorts by frags desc).
export function standingOf(scores: readonly PlayerScore[]): Standing | null {
  const me = scores.find((s) => s.isLocal);
  if (!me) return null;
  const above = scores.filter((s) => s.frags > me.frags).length;
  const tied = scores.some((s) => !s.isLocal && s.frags === me.frags);
  let leader: PlayerScore | null = null;
  for (const s of scores) if (!s.isLocal && (!leader || s.frags > leader.frags)) leader = s;
  return {
    place: above + 1,
    tied,
    frags: me.frags,
    of: scores.length,
    leaderFrags: leader?.frags ?? 0,
    leaderName: leader?.name ?? '',
  };
}

// The Q3 centre-print's second line: "1st place with 12", "Tied for 2nd
// place with 9"; in TDM "Red leads 12 to 9" / "Teams are tied at 5".
export function placementLine(
  scores: readonly PlayerScore[],
  mode: GameMode,
  teamScores: [number, number] | null,
): string | null {
  if (mode === 'tdm' && teamScores) {
    const [r, b] = teamScores;
    if (r === b) return `Teams are tied at ${r}`;
    const lead = r > b ? 0 : 1;
    return `${TEAM_NAMES[lead]} leads ${Math.max(r, b)} to ${Math.min(r, b)}`;
  }
  const st = standingOf(scores);
  if (!st || st.of < 2) return null;
  const p = `${ordinal(st.place)} place with ${st.frags}`;
  return st.tied ? `Tied for ${p}` : p.charAt(0).toUpperCase() + p.slice(1);
}

// Map display name ↔ id (the engine announces joins/next-map by name).
export function mapIdByName(name: string): string | null {
  return MAPS.find((m) => m.map.name === name)?.id ?? null;
}

export function mapNameById(id: string): string {
  return MAPS.find((m) => m.id === id)?.map.name ?? id;
}
