import { memo } from 'react';
import { DEFAULT_NAME_COLOR, nameColorById } from '../../game/cosmetics';
import { TEAM_COLORS, TEAM_NAMES, type GameMode } from '../../game/constants';
import type { PlayerScore } from '../../game/types';
import { NameBadges } from '../badges';
import { ordinal, standingOf } from '../match-info';
import type { HudMatchInfo } from '../hud-quake';

// The Tab scoreboard: a full-width glass card over a light veil. Presentational
// only (plain props, no store); every animation is CSS (src/hud.css, .hud-sb*),
// and it is mounted only while Tab is held, so nothing here runs per frame.

/* ── Formatting helpers ─────────────────────────────────────────────────── */

// One format everywhere: two decimals (no deaths counts as one, so K/D = frags).
function kdOf(s: PlayerScore): string {
  return (s.frags / Math.max(1, s.deaths)).toFixed(2);
}

function pingTone(ping: number): 'good' | 'ok' | 'bad' {
  return ping <= 60 ? 'good' : ping <= 120 ? 'ok' : 'bad';
}

function rankOf(scores: readonly PlayerScore[], s: PlayerScore): number {
  return scores.filter((o) => o.frags > s.frags).length + 1;
}

function isGuestName(name: string): boolean {
  return /^guest[\s_-]?\d*$/i.test(name.trim());
}

// A custom equipped name colour wins; otherwise team colour; otherwise neutral.
function nameColorOf(s: PlayerScore, teamColor?: string): string | undefined {
  if (s.nameColor && s.nameColor !== DEFAULT_NAME_COLOR) return nameColorById(s.nameColor).color;
  return teamColor;
}

/* ── Small pieces ───────────────────────────────────────────────────────── */

// Four signal bars, lit by ping tier (good/ok/bad). Offline / bots: dimmed dash.
function PingBars({ ping }: { ping: number | undefined }) {
  if (ping == null) return <span className='hud-sb-num text-white/25'>—</span>;
  const tone = pingTone(ping);
  const lit = ping <= 40 ? 4 : ping <= 80 ? 3 : ping <= 130 ? 2 : 1;
  return (
    <span className={`hud-sb-ping-cell hud-sb-p-${tone}`} title={`${ping} ms`}>
      <svg width='16' height='12' viewBox='0 0 16 12' aria-hidden='true'>
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={i * 4.2}
            y={12 - (i + 1) * 3}
            width='3'
            height={(i + 1) * 3}
            rx='0.6'
            fill='currentColor'
            opacity={i < lit ? 1 : 0.2}
          />
        ))}
      </svg>
      <span className='tabular-nums'>{ping}</span>
    </span>
  );
}

// Monogram tile standing in for a player-card strip: tinted by name colour or
// team, so a row is recognisable at a glance without any image decode.
function Avatar({ s, color, size = 'md' }: { s: PlayerScore; color?: string; size?: 'md' | 'lg' }) {
  const c = color ?? (s.isLocal ? '#67e8f9' : '#94a3b8');
  return (
    <span
      className={`hud-sb-av${size === 'lg' ? ' hud-sb-av-lg' : ''}`}
      style={{ '--av': c } as React.CSSProperties}
      aria-hidden='true'
    >
      {(s.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

function Tag({ tone, children }: { tone: 'you' | 'bot' | 'guest' | 'fire'; children: React.ReactNode }) {
  return <span className={`hud-sb-tag hud-sb-tag-${tone}`}>{children}</span>;
}

function RankCell({ rank }: { rank: number }) {
  return <span className={`hud-sb-rank${rank <= 3 ? ` hud-sb-rank-${rank}` : ''}`}>{rank}</span>;
}

/* ── Columns ────────────────────────────────────────────────────────────── */

function SbHead({ showPing }: { showPing: boolean }) {
  return (
    <div className={`hud-sb-grid hud-sb-head${showPing ? ' hud-sb-has-ping' : ''}`}>
      <span className='text-center'>#</span>
      <span>Player</span>
      <span className='text-right'>Frags</span>
      <span className='text-right'>Deaths</span>
      <span className='text-right'>K/D</span>
      <span className='text-right'>Acc</span>
      <span className='text-right'>Best</span>
      {showPing && <span className='text-right'>Ping</span>}
    </div>
  );
}

function SbRow({
  s,
  rank,
  showPing,
  teamColor,
  online,
  scale,
}: {
  s: PlayerScore;
  rank: number;
  showPing: boolean;
  teamColor?: string;
  online: boolean;
  scale: number;
}) {
  const color = nameColorOf(s, teamColor);
  const bot = !online && !s.isLocal;
  const guest = online && isGuestName(s.name);
  return (
    <div className={`hud-sb-grid hud-sb-row${s.isLocal ? ' hud-sb-self' : ''}${showPing ? ' hud-sb-has-ping' : ''}`}>
      {/* Frag progress behind the row: how close this player is to the limit. */}
      <span
        className='hud-sb-fill'
        style={{ transform: `scaleX(${Math.min(1, s.frags / scale)})`, background: teamColor ?? undefined }}
      />
      <RankCell rank={rank} />
      <span className='flex min-w-0 items-center gap-3'>
        <Avatar s={s} color={color ?? teamColor} />
        <span className='flex min-w-0 flex-col justify-center'>
          <span className='flex min-w-0 items-center gap-1.5'>
            <span
              className={`truncate text-[15px] font-semibold ${s.isLocal && !color ? 'text-cyan-100' : 'text-white/90'}`}
              style={color ? { color } : undefined}
            >
              {s.name}
            </span>
            <NameBadges admin={s.admin} verified={s.verified} size={13} />
            {s.isLocal && <Tag tone='you'>You</Tag>}
            {bot && <Tag tone='bot'>Bot</Tag>}
            {guest && !s.isLocal && <Tag tone='guest'>Guest</Tag>}
            {s.currentStreak >= 3 && <Tag tone='fire'>On fire {s.currentStreak}</Tag>}
          </span>
          {s.title && <span className='hud-sb-title truncate'>{s.title}</span>}
        </span>
      </span>
      <span className='hud-sb-frags'>{s.frags}</span>
      <span className='hud-sb-num'>{s.deaths}</span>
      <span className='hud-sb-num'>{kdOf(s)}</span>
      <AccCell acc={s.accuracy} />
      <span className='hud-sb-num'>{s.bestStreak}</span>
      {showPing && <PingBars ping={s.ping} />}
    </div>
  );
}

// Accuracy as a number with a hairline meter under it (null = unknown).
function AccCell({ acc }: { acc: number | null | undefined }) {
  if (acc == null) return <span className='hud-sb-num text-white/30'>—</span>;
  const v = Math.max(0, Math.min(100, Math.round(acc)));
  return (
    <span className='hud-sb-acc'>
      <span className='hud-sb-num'>{v}%</span>
      <span className='hud-sb-acc-bar'>
        <span style={{ transform: `scaleX(${v / 100})` }} />
      </span>
    </span>
  );
}

/* ── Header ─────────────────────────────────────────────────────────────── */

function PingLegend() {
  return (
    <div className='hud-sb-legend' aria-label='Ping legend'>
      <span className='hud-sb-p-good'>
        <i /> ≤60
      </span>
      <span className='hud-sb-p-ok'>
        <i /> ≤120
      </span>
      <span className='hud-sb-p-bad'>
        <i /> 120+
      </span>
      <span className='text-white/35'>ms</span>
    </div>
  );
}

function SbHeader({
  info,
  fallbackLine,
  mode,
  scores,
  showPing,
  best,
}: {
  info?: HudMatchInfo;
  fallbackLine: string;
  mode: GameMode;
  scores: PlayerScore[];
  showPing: boolean;
  best: number;
}) {
  const st = standingOf(scores);
  const limit = info?.fragLimit ?? null;
  // The chip already names the mode: drop the line's leading "Free-for-all ·".
  const modeLine = info ? info.modeLine.split(' · ').slice(1).join(' · ') || info.modeLine : fallbackLine;
  return (
    <div className='hud-sb-header'>
      <div className='min-w-0'>
        <div className='hud-sb-kicker'>
          <span className='hud-sb-modechip'>{mode === 'tdm' ? 'TDM' : mode === 'duel' ? 'Duel' : 'FFA'}</span>
          <span className='truncate'>{modeLine}</span>
        </div>
        <div className='hud-sb-map'>{info?.mapName || 'Instagib Arena'}</div>
      </div>
      <div className='flex shrink-0 items-end gap-8'>
        {limit != null && (
          <div className='hud-sb-limit'>
            <div className='flex items-baseline justify-between gap-6'>
              <span className='hud-sb-kicker-sm'>{mode === 'tdm' ? 'Leading team' : 'Leader'}</span>
              <span className='font-display text-lg font-bold tabular-nums text-white'>
                {best}
                <span className='text-white/40'> / {limit}</span>
              </span>
            </div>
            <div className='hud-sb-limit-bar'>
              <span style={{ transform: `scaleX(${Math.min(1, best / limit)})` }} />
            </div>
          </div>
        )}
        {st && mode !== 'tdm' && st.of > 1 && (
          <div className='text-right'>
            <div className='font-display text-[3.1rem] font-bold leading-[0.85] text-white'>{ordinal(st.place)}</div>
            <div className='hud-sb-kicker-sm mt-1.5'>
              {st.tied ? 'Tied · ' : ''}of {st.of}
            </div>
          </div>
        )}
      </div>
      {showPing && <PingLegend />}
    </div>
  );
}

/* ── Layouts ────────────────────────────────────────────────────────────── */

function TeamBlock({
  team,
  players,
  showPing,
  online,
  scale,
}: {
  team: 0 | 1;
  players: PlayerScore[];
  showPing: boolean;
  online: boolean;
  scale: number;
}) {
  const total = players.reduce((sum, s) => sum + s.frags, 0);
  const color = TEAM_COLORS[team];
  return (
    <div className='hud-sb-team' style={{ '--team': color } as React.CSSProperties}>
      <div className='hud-sb-team-head'>
        <span className='font-display text-lg font-bold uppercase tracking-[0.14em]' style={{ color }}>
          {TEAM_NAMES[team]}
        </span>
        <span className='hud-sb-kicker-sm'>
          {players.length} {players.length === 1 ? 'player' : 'players'}
        </span>
        <span className='ml-auto font-display text-3xl font-bold tabular-nums leading-none' style={{ color }}>
          {total}
        </span>
      </div>
      <SbHead showPing={showPing} />
      {players.map((s) => (
        <SbRow
          key={s.id}
          s={s}
          rank={rankOf(players, s)}
          showPing={showPing}
          teamColor={color}
          online={online}
          scale={scale}
        />
      ))}
    </div>
  );
}

// 1v1: two big panels with the scores between them, you on the left.
function DuelFaceOff({
  scores,
  online,
  showPing,
  limit,
}: {
  scores: PlayerScore[];
  online: boolean;
  showPing: boolean;
  limit: number | null;
}) {
  const me = scores.find((s) => s.isLocal) ?? scores[0];
  const foe = scores.find((s) => s !== me) ?? scores[1];
  const side = (s: PlayerScore, self: boolean) => {
    const color = nameColorOf(s) ?? (self ? '#a5f3fc' : '#ffb4bd');
    const leading = s.frags > (self ? foe : me).frags;
    const bot = !online && !s.isLocal;
    return (
      <div className={`hud-sb-duel-side ${self ? 'hud-sb-duel-me' : 'hud-sb-duel-foe'}${leading ? ' hud-sb-duel-lead' : ''}`}>
        <Avatar s={s} color={color} size='lg' />
        <div className='flex min-w-0 flex-col items-center gap-1'>
          <span className='flex min-w-0 items-center gap-1.5'>
            <span className='truncate font-display text-2xl font-bold uppercase tracking-[0.04em]' style={{ color }}>
              {s.name}
            </span>
            <NameBadges admin={s.admin} verified={s.verified} size={16} />
          </span>
          {s.title && <span className='hud-sb-title'>{s.title}</span>}
          <span className='flex gap-1.5'>
            {s.isLocal && <Tag tone='you'>You</Tag>}
            {bot && <Tag tone='bot'>Bot</Tag>}
            {s.currentStreak >= 3 && <Tag tone='fire'>On fire {s.currentStreak}</Tag>}
          </span>
        </div>
        <span key={s.frags} className='hud-sb-duel-frags hud-tick hud-tick-center'>
          {s.frags}
        </span>
        <div className='hud-sb-duel-stats'>
          <span>
            <b>{s.deaths}</b>Deaths
          </span>
          <span>
            <b>{kdOf(s)}</b>K/D
          </span>
          <span>
            <b>{s.accuracy == null ? '—' : `${Math.round(s.accuracy)}%`}</b>Acc
          </span>
          <span>
            <b>{s.bestStreak}</b>Best
          </span>
          {showPing && (
            <span>
              <b>{s.ping == null ? '—' : s.ping}</b>Ping
            </span>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className='hud-sb-duel'>
      {side(me, true)}
      <div className='hud-sb-duel-vs'>
        <span>VS</span>
        {limit != null && <em>First to {limit}</em>}
      </div>
      {side(foe, false)}
    </div>
  );
}

/* ── The scoreboard ─────────────────────────────────────────────────────── */

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
  const isTeam = mode === 'tdm';
  const fallbackLine = isTeam ? 'Team deathmatch' : mode === 'duel' ? 'Duel' : 'Free-for-all';
  const limit = info?.fragLimit ?? null;
  const teamTotals: [number, number] = [0, 0];
  for (const s of scores) {
    if (s.team === 0) teamTotals[0] += s.frags;
    else if (s.team === 1) teamTotals[1] += s.frags;
  }
  const best = isTeam ? Math.max(teamTotals[0], teamTotals[1]) : scores.reduce((m, s) => Math.max(m, s.frags), 0);
  // Row progress fills scale to the frag limit (or the current leader when endless).
  const rowScale = Math.max(1, limit ?? best);
  const duel = mode === 'duel' && scores.length === 2;
  const offTeam = scores.filter((s) => s.team !== 0 && s.team !== 1);

  return (
    <div className='hud-sb-veil absolute inset-0 z-30 flex items-start justify-center px-4 pb-4 pt-[112px]'>
      <div className='hud-sb flex max-h-full w-[1040px] max-w-[96vw] flex-col'>
        <SbHeader
          info={info}
          fallbackLine={fallbackLine}
          mode={mode}
          scores={scores}
          showPing={showPing}
          best={best}
        />
        {isTeam && (
          <div className='hud-sb-tug' aria-hidden='true'>
            <span style={{ flexGrow: Math.max(teamTotals[0], 0.5), background: TEAM_COLORS[0] }} />
            <span style={{ flexGrow: Math.max(teamTotals[1], 0.5), background: TEAM_COLORS[1] }} />
          </div>
        )}
        <div className='deck-scroll min-h-0 overflow-y-auto px-4 pb-3 pt-2'>
          {duel ? (
            <DuelFaceOff scores={scores} online={online} showPing={showPing} limit={limit} />
          ) : isTeam ? (
            <>
              {([0, 1] as const).map((team) => (
                <TeamBlock
                  key={team}
                  team={team}
                  players={scores.filter((s) => s.team === team)}
                  showPing={showPing}
                  online={online}
                  scale={rowScale}
                />
              ))}
              {/* Anyone not (yet) on a team — e.g. mid-assignment — still gets a row. */}
              {offTeam.length > 0 && (
                <div className='mt-3'>
                  <SbHead showPing={showPing} />
                  {offTeam.map((s) => (
                    <SbRow
                      key={s.id}
                      s={s}
                      rank={rankOf(scores, s)}
                      showPing={showPing}
                      online={online}
                      scale={rowScale}
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <SbHead showPing={showPing} />
              {scores.map((s) => (
                <SbRow
                  key={s.id}
                  s={s}
                  rank={rankOf(scores, s)}
                  showPing={showPing}
                  online={online}
                  scale={rowScale}
                />
              ))}
            </>
          )}
        </div>
        <div className='hud-sb-foot'>
          <span>{online ? 'Online match' : 'Offline · vs bots'}</span>
          <span>{scores.length} players</span>
          <span>Release Tab to close</span>
        </div>
      </div>
    </div>
  );
});
