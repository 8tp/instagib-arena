import { memo } from 'react';
import { TEAM_COLORS, TEAM_NAMES, type GameMode } from '../game/constants';
import type { KillfeedEntry, PlayerScore } from '../game/types';
import { hudTiming, useExitList } from '../hud-store';
import { NameBadges } from './badges';
import { HUD_EXIT_LEAD_MS, HUD_EXIT_MS } from './hud-const';
import { ordinal, standingOf } from './match-info';

// Quake-style HUD pieces: the score boxes (big numerals, top-centre), the
// compact killfeed, the Tab scoreboard, and the "Fight!" call. All are plain
// presentational components: the store-connected wrappers live with the HUD
// layout in InstagibClient, and every animation is CSS keyed by an id or a
// value (src/hud.css) — nothing here re-renders per frame.

export type HudMatchInfo = {
  mapName: string;
  modeLine: string; // "Free-for-all · first to 25 frags"
  fragLimit: number | null;
};

/* ── Score boxes ────────────────────────────────────────────────────────── */

function ScoreBox({ value, label, tone }: { value: number; label: string; tone: 'self' | 'other' | 'red' | 'blue' }) {
  return (
    <div className={`hud-sbox hud-sbox-${tone}`}>
      {/* Keyed on the value: every frag ticks the numeral in. */}
      <span key={value} className='hud-sbox-num hud-tick hud-tick-center'>
        {value}
      </span>
      <span className='hud-sbox-label'>{label}</span>
    </div>
  );
}

// You vs the best other player (FFA / Duel), or Red vs Blue (TDM), with the
// frag limit under them. Your box carries your placement.
export const ScoreBoxes = memo(function ScoreBoxes({
  scores,
  mode,
  teamScores,
  localTeam,
  fragLimit,
}: {
  scores: PlayerScore[];
  mode: GameMode;
  teamScores: [number, number] | null;
  localTeam: number | null;
  fragLimit: number | null;
}) {
  let boxes: React.ReactNode;
  if (mode === 'tdm' && teamScores) {
    boxes = ([0, 1] as const).map((t) => (
      <ScoreBox
        key={t}
        value={teamScores[t]}
        label={localTeam === t ? `${TEAM_NAMES[t]} · you` : TEAM_NAMES[t]}
        tone={t === 0 ? 'red' : 'blue'}
      />
    ));
  } else {
    const st = standingOf(scores);
    if (!st || st.of < 2) return null;
    boxes = (
      <>
        <ScoreBox value={st.frags} label={st.tied ? `Tied ${ordinal(st.place)}` : ordinal(st.place)} tone='self' />
        <ScoreBox value={st.leaderFrags} label={st.leaderName} tone='other' />
      </>
    );
  }
  return (
    <div className='absolute inset-x-0 top-3 flex flex-col items-center'>
      <div className='flex items-stretch gap-[3px]'>{boxes}</div>
      {fragLimit != null && <div className='hud-sbox-limit'>First to {fragLimit}</div>}
    </div>
  );
});

/* ── Killfeed ───────────────────────────────────────────────────────────── */

// The rail glyph between killer and victim: a beam with a hot core.
function RailGlyph() {
  return (
    <svg width='26' height='8' viewBox='0 0 26 8' aria-label='railed' className='shrink-0'>
      <line x1='1' y1='4' x2='20' y2='4' stroke='#22d3ee' strokeWidth='2.2' strokeLinecap='round' />
      <line x1='3' y1='4' x2='20' y2='4' stroke='#ecfeff' strokeWidth='0.9' strokeLinecap='round' />
      <path d='M20 1 L25 4 L20 7 Z' fill='#67e8f9' />
    </svg>
  );
}

export const Killfeed = memo(function Killfeed({
  entries,
  localName,
}: {
  entries: KillfeedEntry[];
  localName?: string;
}) {
  const rows = useExitList(entries, { exitMs: HUD_EXIT_MS, leadMs: HUD_EXIT_LEAD_MS });
  return (
    <div className='absolute right-5 top-5 flex w-[22rem] flex-col items-end gap-[3px]'>
      {rows.map(({ item, leaving }) => (
        <KillfeedRow
          key={item.id}
          entry={item}
          leaving={leaving}
          victimLocal={!!localName && !item.killerLocal && item.victim === localName}
        />
      ))}
    </div>
  );
});

// Slides in from the right, holds, and fades on a pre-scheduled CSS delay (see
// hudTiming) — no React updates between mount and unmount. `leaving` plays the
// fade now when the engine dropped the row early (feed cap / reset).
const KillfeedRow = memo(function KillfeedRow({
  entry,
  leaving,
  victimLocal,
}: {
  entry: KillfeedEntry;
  leaving: boolean;
  victimLocal: boolean;
}) {
  const tag =
    entry.special === 'headshot'
      ? { text: 'HS', cls: 'hud-kf-tag-hs' }
      : entry.special === 'mid-air'
        ? { text: 'AIR', cls: 'hud-kf-tag-air' }
        : null;
  const tone = entry.killerLocal ? ' hud-kf-you' : victimLocal ? ' hud-kf-died' : '';
  return (
    <div
      className={`hud-chip hud-kf${tone}${leaving ? ' hud-leaving' : ''}`}
      style={hudTiming(entry.remaining, entry.total, HUD_EXIT_LEAD_MS)}
    >
      <span className={`hud-kf-name${entry.killerLocal ? ' hud-kf-self' : ''}`}>{entry.killer}</span>
      <RailGlyph />
      <span className={`hud-kf-name ${victimLocal ? 'hud-kf-self-dead' : 'hud-kf-victim'}`}>{entry.victim}</span>
      {tag && <span className={`hud-kf-tag ${tag.cls}`}>{tag.text}</span>}
    </div>
  );
});

/* ── Tab scoreboard ─────────────────────────────────────────────────────── */

function kdOf(s: PlayerScore): string {
  return s.deaths === 0 ? s.frags.toFixed(1) : (s.frags / Math.max(1, s.deaths)).toFixed(2);
}

function accOf(acc: number | null | undefined): string {
  return acc == null ? '—' : `${Math.round(acc)}%`;
}

function pingTone(ping: number): string {
  return ping <= 60 ? 'text-emerald-300' : ping <= 120 ? 'text-amber-300' : 'text-rose-300';
}

function SbHead({ showPing }: { showPing: boolean }) {
  return (
    <div className={`hud-sb-grid hud-sb-head${showPing ? ' hud-sb-ping' : ''}`}>
      <span className='text-right'>#</span>
      <span>Player</span>
      <span className='text-right'>Frags</span>
      <span className='text-right'>Deaths</span>
      <span className='text-right'>K/D</span>
      <span className='text-right'>Acc</span>
      <span className='text-right'>Streak</span>
      {showPing && <span className='text-right'>Ping</span>}
    </div>
  );
}

function SbRow({
  s,
  rank,
  showPing,
  teamColor,
}: {
  s: PlayerScore;
  rank: number;
  showPing: boolean;
  teamColor?: string;
}) {
  return (
    <div className={`hud-sb-grid hud-sb-row${s.isLocal ? ' hud-sb-self' : ''}${showPing ? ' hud-sb-ping' : ''}`}>
      <span className='text-right font-mono text-[12px] tabular-nums text-white/40'>{rank}</span>
      <span className='flex min-w-0 flex-col justify-center'>
        <span className='flex min-w-0 items-center gap-2'>
          <span
            className={`truncate text-[15px] font-semibold ${s.isLocal ? 'text-cyan-100' : 'text-white/90'}`}
            style={!s.isLocal && teamColor ? { color: teamColor } : undefined}
          >
            {s.name}
          </span>
          <NameBadges admin={s.admin} verified={s.verified} size={13} />
          {s.currentStreak >= 3 && <span className='hud-sb-fire'>On fire {s.currentStreak}</span>}
        </span>
        {s.title && (
          <span className='truncate font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-white/40'>
            {s.title}
          </span>
        )}
      </span>
      <span className='hud-sb-frags'>{s.frags}</span>
      <span className='hud-sb-num'>{s.deaths}</span>
      <span className='hud-sb-num'>{kdOf(s)}</span>
      <span className='hud-sb-num'>{accOf(s.accuracy)}</span>
      <span className='hud-sb-num'>{s.bestStreak}</span>
      {showPing && (
        <span className={`hud-sb-num ${s.ping == null ? 'text-white/30' : pingTone(s.ping)}`}>
          {s.ping == null ? '—' : s.ping}
        </span>
      )}
    </div>
  );
}

function rankOf(scores: readonly PlayerScore[], s: PlayerScore): number {
  return scores.filter((o) => o.frags > s.frags).length + 1;
}

export const QuakeScoreboard = memo(function QuakeScoreboard({
  scores,
  online,
  mode,
  showPing = false,
  info,
}: {
  scores: PlayerScore[];
  online: boolean;
  mode: GameMode;
  showPing?: boolean;
  info?: HudMatchInfo;
}) {
  const st = standingOf(scores);
  const isTeam = mode === 'tdm';
  const fallbackLine = mode === 'tdm' ? 'Team deathmatch' : mode === 'duel' ? 'Duel' : 'Free-for-all';
  return (
    <div className='hud-sb-veil absolute inset-0 flex items-center justify-center p-4'>
      <div className='hud-sb clip-deck flex max-h-[92%] w-[880px] max-w-[96vw] flex-col'>
        <div className='flex shrink-0 items-end justify-between gap-6 border-b border-white/10 px-7 pb-4 pt-6'>
          <div className='min-w-0'>
            <div className='font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-300'>
              {info?.modeLine ?? fallbackLine}
            </div>
            <div className='mt-1.5 truncate font-display text-[2.6rem] font-bold uppercase leading-[0.9] tracking-[0.02em] text-white'>
              {info?.mapName || 'Instagib Arena'}
            </div>
          </div>
          {st && !isTeam && st.of > 1 && (
            <div className='shrink-0 text-right'>
              <div className='font-display text-5xl font-bold leading-[0.85] text-white'>{ordinal(st.place)}</div>
              <div className='mt-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/50'>
                {st.tied ? 'Tied · ' : ''}of {st.of}
              </div>
            </div>
          )}
        </div>
        <div className='deck-scroll min-h-0 overflow-y-auto px-4 pb-3 pt-2'>
          {isTeam ? (
            ([0, 1] as const).map((team) => {
              const players = scores.filter((s) => s.team === team);
              const total = players.reduce((sum, s) => sum + s.frags, 0);
              const color = TEAM_COLORS[team];
              return (
                <div key={team} className='mt-3 first:mt-1'>
                  <div
                    className='flex items-baseline justify-between px-3 py-1.5'
                    style={{ background: `${color}1f`, boxShadow: `inset 3px 0 0 ${color}` }}
                  >
                    <span className='font-display text-lg font-bold uppercase tracking-[0.12em]' style={{ color }}>
                      {TEAM_NAMES[team]}
                    </span>
                    <span className='font-display text-3xl font-bold tabular-nums leading-none' style={{ color }}>
                      {total}
                    </span>
                  </div>
                  <SbHead showPing={showPing} />
                  {players.map((s) => (
                    <SbRow key={s.id} s={s} rank={rankOf(players, s)} showPing={showPing} teamColor={color} />
                  ))}
                </div>
              );
            })
          ) : (
            <>
              <SbHead showPing={showPing} />
              {scores.map((s) => (
                <SbRow key={s.id} s={s} rank={rankOf(scores, s)} showPing={showPing} />
              ))}
            </>
          )}
        </div>
        <div className='flex shrink-0 justify-between border-t border-white/10 px-7 py-2.5 font-mono text-[10px] uppercase tracking-[0.2em] text-white/35'>
          <span>{online ? 'Online match' : 'Offline · vs bots'}</span>
          <span>Release Tab to close</span>
        </div>
      </div>
    </div>
  );
});

/* ── Fight! ─────────────────────────────────────────────────────────────── */

// The warmup's last word: one CSS stamp-and-fade, unmounted on animation end.
export function FightCall({ onDone }: { onDone: () => void }) {
  return (
    <div className='pointer-events-none absolute inset-x-0 top-[36%] flex justify-center'>
      <span className='hud-fight' onAnimationEnd={onDone}>
        Fight!
      </span>
    </div>
  );
}
