import { MULTIKILL_WINDOW_SEC } from './constants';
import type { Medal, MedalTier } from './types';

type KillRecord = { t: number };

export class MedalTracker {
  private kills: KillRecord[] = [];
  private streak = 0;
  bestStreak = 0;

  onKill(now: number, opts: { midAir: boolean; headshot: boolean; firstBlood?: boolean }): Medal[] {
    this.kills.push({ t: now });
    while (this.kills.length > 0 && now - this.kills[0].t > MULTIKILL_WINDOW_SEC + 0.5) {
      this.kills.shift();
    }
    const medals: Medal[] = [];

    if (opts.firstBlood) medals.push('first-blood');
    if (opts.headshot) medals.push('headshot');
    if (opts.midAir) medals.push('mid-air');

    const recent = this.kills.filter((k) => now - k.t <= MULTIKILL_WINDOW_SEC).length;
    if (recent === 2) medals.push('double-kill');
    else if (recent === 3) medals.push('multi-kill');
    else if (recent === 4) medals.push('ultra-kill');
    else if (recent >= 5) medals.push('monster-kill');

    this.streak += 1;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    const streakMedal = streakMedalFor(this.streak);
    if (streakMedal) medals.push(streakMedal);

    return medals;
  }

  onDeath() {
    this.streak = 0;
  }

  get currentStreak(): number {
    return this.streak;
  }
}

function streakMedalFor(streak: number): Medal | null {
  if (streak === 5) return 'killing-spree';
  if (streak === 10) return 'rampage';
  if (streak === 15) return 'dominating';
  if (streak === 20) return 'unstoppable';
  if (streak === 30) return 'godlike';
  return null;
}

export const MEDAL_LABELS: Record<
  Medal,
  { title: string; subtitle?: string; tier: MedalTier }
> = {
  'first-blood':    { title: 'First Blood',    tier: 'special' },
  'headshot':       { title: 'Headshot',       tier: 'special' },
  'mid-air':        { title: 'Jump Shot',      subtitle: 'mid-air',     tier: 'special' },
  'double-kill':    { title: 'Double Kill',    subtitle: '×2',          tier: 'multi'   },
  'multi-kill':     { title: 'Triple Kill',    subtitle: '×3',          tier: 'multi'   },
  'ultra-kill':     { title: 'Quad Kill',      subtitle: '×4',          tier: 'multi'   },
  'monster-kill':   { title: 'Penta Kill',     subtitle: '×5',          tier: 'multi'   },
  'killing-spree':  { title: 'Killing Spree',  subtitle: '5 streak',    tier: 'streak'  },
  'rampage':        { title: 'Rampage',        subtitle: '10 streak',   tier: 'streak'  },
  'dominating':     { title: 'Dominating',     subtitle: '15 streak',   tier: 'streak'  },
  'unstoppable':    { title: 'Unstoppable',    subtitle: '20 streak',   tier: 'streak'  },
  'godlike':        { title: 'Godlike',        subtitle: '30 streak',   tier: 'streak'  },
  'comeback':       { title: 'Comeback',        subtitle: 'against the odds', tier: 'special' },
};

// Procedural sting level per medal (sfx/stings.ts), keyed by tier: the multi-kill
// arpeggio has one note per kill in the chain; the streak swell climbs with the
// streak. Played when the announcer can't voice the headline medal (announcer
// off / no clip or TTS), so no medal ever lands silently.
const MEDAL_STING_LEVEL: Partial<Record<Medal, number>> = {
  'double-kill': 2,
  'multi-kill': 3,
  'ultra-kill': 4,
  'monster-kill': 5,
  'killing-spree': 1,
  'rampage': 2,
  'dominating': 3,
  'unstoppable': 4,
  'godlike': 5,
};

export function medalSting(medal: Medal): { kind: MedalTier; level: number } {
  return { kind: MEDAL_LABELS[medal].tier, level: MEDAL_STING_LEVEL[medal] ?? 1 };
}

// Medals that warrant the big center-screen banner (vs. just a toast)
export const BANNER_MEDALS = new Set<Medal>([
  'first-blood',
  'double-kill',
  'multi-kill',
  'ultra-kill',
  'monster-kill',
  'killing-spree',
  'rampage',
  'dominating',
  'unstoppable',
  'godlike',
  'comeback',
]);
