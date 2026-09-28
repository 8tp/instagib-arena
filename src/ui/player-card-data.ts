// Playercard data helpers (stat picker defs, payload builder, rarity accents).
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { rankedTierName } from '../game/constants';
import { titleById, type Rarity } from '../game/cosmetics';
import type { CardPayload } from '../game/types';

// Rarity → accent color for cosmetic cards in the Locker.
export const RARITY_STYLE: Record<Rarity, string> = {
  common: 'text-white/45',
  rare: 'text-sky-300',
  epic: 'text-fuchsia-300',
  legendary: 'text-amber-300',
};

// Career stats a player can show on their playercard (the kill banner).
export const CARD_STAT_DEFS: ReadonlyArray<{
  key: string;
  label: string;
  from: (p: InstagibProfile) => string;
}> = [
  { key: 'kills', label: 'KILLS', from: (p) => String(p.stats.totalKills) },
  { key: 'deaths', label: 'DEATHS', from: (p) => String(p.stats.totalDeaths) },
  { key: 'wins', label: 'WINS', from: (p) => String(p.stats.totalWins) },
  { key: 'games', label: 'GAMES', from: (p) => String(p.stats.totalGames) },
  {
    key: 'kd',
    label: 'K/D',
    from: (p) =>
      p.stats.totalDeaths > 0
        ? (p.stats.totalKills / p.stats.totalDeaths).toFixed(2)
        : String(p.stats.totalKills),
  },
  { key: 'streak', label: 'BEST STREAK', from: (p) => String(p.stats.bestKillStreak) },
  { key: 'headshots', label: 'HEADSHOTS', from: (p) => String(p.stats.headshots) },
  { key: 'accuracy', label: 'ACCURACY', from: (p) => `${Math.round(p.stats.bestAccuracy)}%` },
  // Ranked Elo — "Unranked" until you've played a ranked match.
  { key: 'rating', label: 'RANKED', from: (p) => (p.ranked ? String(p.ranked.rating) : 'Unranked') },
];

export const MAX_CARD_STATS = 3;

export function buildCardPayload(
  profile: InstagibProfile,
  settings: Settings,
  account?: Account,
): CardPayload {
  const stats = settings.cardStats
    .map((k) => CARD_STAT_DEFS.find((d) => d.key === k))
    .filter((d): d is (typeof CARD_STAT_DEFS)[number] => !!d)
    .slice(0, MAX_CARD_STATS)
    .map((d) => ({ label: d.label, value: d.from(profile) }));
  // A dynamic ranked title resolves to the live standing locally for the preview +
  // the player's own kill-confirm card; the server re-forces it on the killcard
  // others see, so this can't be faked.
  const titleDef = titleById(settings.title);
  const title = titleDef.dynamic === 'ranked' ? rankedStandingText(profile.ranked) : titleDef.text;
  // Badges mirror the account (server overrides them on the killcard others see,
  // so this only drives the local Locker preview). Guests carry neither.
  return {
    name: settings.playerName || 'Player',
    level: profile.level,
    style: settings.card,
    stats,
    title,
    verified: !!account?.isVerified,
    admin: !!account?.isAdmin,
  };
}

// The live flair text for the dynamic ranked title from a profile's standing:
// top-10 → "#N", otherwise the tier name; '' if the player has no ranked games.
export function rankedStandingText(ranked: InstagibProfile['ranked']): string {
  if (!ranked) return '';
  return ranked.rank >= 1 && ranked.rank <= 10 ? `#${ranked.rank}` : rankedTierName(ranked.rating);
}
