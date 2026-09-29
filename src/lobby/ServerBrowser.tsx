import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DeckButton, Skeleton } from '../deck';
import { sfxProps } from '../deck-core';
import { NameBadges } from '../ui/badges';
import type { GameMode } from '../game/constants';
import type { ChatMessage, LobbyRoom, LobbyStatus, PresencePlayer, PresenceState } from '../game/net';
import { CHAT_CLIENT_MAX_LEN, hueOf, mapParts, mapShotStyle, useMapShot } from './helpers';
import { IconAlert, IconChat, IconRadar, IconUsers } from './shared';
import './lobby.css';

// Compact mode badge — color-coded by mode for quick scanning in lobby rows.
export function ModeBadge({ mode }: { mode: GameMode }) {
  const color =
    mode === 'tdm' ? 'border-sky-300/40 bg-sky-300/15 text-sky-200' :
    mode === 'duel' ? 'border-fuchsia-300/40 bg-fuchsia-300/15 text-fuchsia-200' :
    'border-emerald-300/40 bg-emerald-300/15 text-emerald-200';
  const short = mode === 'tdm' ? 'TDM' : mode === 'duel' ? '1v1' : 'FFA';
  return <span className={`deck-chip ${color}`}>{short}</span>;
}

export function ServerStatusChip({ status }: { status: LobbyStatus }) {
  const map = {
    open: { dot: 'bg-emerald-400', ring: 'border-emerald-400/40 text-emerald-200', t: 'Online', title: 'Connected — online play available' },
    connecting: { dot: 'bg-amber-400', ring: 'border-amber-400/40 text-amber-200', t: 'Linking', title: 'Connecting to the match server…' },
    closed: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
    error: { dot: 'bg-rose-400', ring: 'border-rose-400/40 text-rose-200', t: 'Offline', title: 'Match server unreachable — solo vs bots still works' },
  } as const;
  const s = map[status];
  return (
    <span
      title={s.title}
      className={`clip-deck-sm inline-flex items-center gap-1.5 border px-2.5 py-1 font-display text-[12px] font-bold uppercase tracking-[0.1em] ${s.ring}`}
    >
      <span className={`deck-pulse h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.t}
    </span>
  );
}

// One centred empty / loading / error block used by all three dock tabs.
function StateBlock({
  icon,
  title,
  children,
  tone = 'plain',
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  tone?: 'plain' | 'rose';
}) {
  return (
    <div className='lb-state h-full'>
      <span className={`lb-state-icon ${tone === 'rose' ? '!border-rose-400/40 !text-rose-300' : ''}`}>{icon}</span>
      <span className='lb-state-title'>{title}</span>
      {children && <span className='lb-note max-w-[16rem]'>{children}</span>}
    </div>
  );
}

function LobbySkeleton() {
  return (
    <div className='flex flex-col gap-2' aria-busy='true' aria-label='Loading lobbies'>
      {[0, 1, 2].map((i) => (
        <div key={i} className='flex gap-2.5 border border-white/8 bg-white/[0.03] p-2.5'>
          <Skeleton className='h-11 w-[4.5rem] shrink-0' />
          <div className='flex flex-1 flex-col justify-center gap-2'>
            <Skeleton className='h-3 w-2/3' />
            <Skeleton className='h-2.5 w-1/3' />
          </div>
        </div>
      ))}
    </div>
  );
}

const MODE_FILTERS: ReadonlyArray<{ id: 'all' | GameMode; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'ffa', label: 'FFA' },
  { id: 'duel', label: '1v1' },
  { id: 'tdm', label: 'TDM' },
];

function RoomCard({
  room: r,
  onJoin,
  onSpectate,
}: {
  room: LobbyRoom;
  onJoin: (r: LobbyRoom) => void;
  onSpectate: (r: LobbyRoom) => void;
}) {
  const shot = useMapShot(r.mapId);
  const { name: mapName } = mapParts(r.mapId);
  const pct = Math.min(100, Math.round((r.players / Math.max(1, r.capacity)) * 100));
  return (
    <li className='lb-room'>
      <div className='flex items-center gap-2.5'>
        <div className='lb-room-shot' style={mapShotStyle(r.mapId, shot)} aria-hidden='true' />
        <div className='min-w-0 flex-1'>
          <div className='truncate font-display text-[13px] font-semibold text-white'>{r.name}</div>
          <div className='mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.1em] text-white/50'>
            <ModeBadge mode={r.mode} />
            <span className='truncate'>{mapName}</span>
          </div>
        </div>
        <div className='shrink-0 text-right'>
          <div className='font-display text-[15px] font-bold tabular-nums leading-none text-white'>
            {r.players}
            <span className='text-white/40'>/{r.capacity}</span>
          </div>
          <div className='mt-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/35'>players</div>
        </div>
      </div>
      <div className='lb-fill' data-full={!r.joinable} role='presentation'>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex min-w-0 flex-wrap items-center gap-1.5'>
          {r.state === 'voting' && <span className='deck-chip border-cyan-300/40 bg-cyan-300/15 text-cyan-200'>voting</span>}
          {r.spectators > 0 && <span className='deck-chip text-white/60'>{r.spectators} watching</span>}
        </div>
        <div className='flex shrink-0 items-center gap-1.5'>
          {/* Watch is always available for live matches — the whole point
              is that a FULL match is still watchable. */}
          <DeckButton onClick={() => onSpectate(r)} title='Spectate this match' size='sm' center>
            Watch
          </DeckButton>
          <DeckButton onClick={() => onJoin(r)} disabled={!r.joinable} solid accent='emerald' size='sm' center>
            {r.joinable ? 'Join' : 'Full'}
          </DeckButton>
        </div>
      </div>
    </li>
  );
}

// Body of the menu's social dock (the dock supplies the frame + tabs): the
// server browser — open custom/public lobbies with map, mode and fill.
export function OpenLobbies({
  rooms,
  online,
  status,
  onJoin,
  onSpectate,
  onRefresh,
}: {
  rooms: LobbyRoom[];
  online: boolean;
  status?: LobbyStatus;
  onJoin: (r: LobbyRoom) => void;
  onSpectate: (r: LobbyRoom) => void;
  onRefresh: () => void;
}) {
  const [modeFilter, setModeFilter] = useState<'all' | GameMode>('all');
  const [hideFull, setHideFull] = useState(false);
  const failed = status === 'closed' || status === 'error';
  const shown = useMemo(
    () => rooms.filter((r) => (modeFilter === 'all' || r.mode === modeFilter) && (!hideFull || r.joinable)),
    [rooms, modeFilter, hideFull],
  );
  const filtering = modeFilter !== 'all' || hideFull;
  return (
    <>
      <div className='flex shrink-0 items-center justify-between px-4 pb-2 pt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45'>
        <span>
          {online
            ? `${rooms.length} open ${rooms.length === 1 ? 'lobby' : 'lobbies'}`
            : failed
              ? 'Server offline'
              : 'Linking to server…'}
        </span>
        <button
          type='button'
          onClick={onRefresh}
          disabled={!online}
          {...sfxProps('uiClick')}
          className='text-cyan-300/70 transition hover:text-cyan-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300/80 disabled:opacity-40'
        >
          Refresh
        </button>
      </div>
      {online && rooms.length > 0 && (
        <div className='lb-filters' role='group' aria-label='Filter lobbies'>
          {MODE_FILTERS.map((f) => (
            <button
              key={f.id}
              type='button'
              aria-pressed={modeFilter === f.id}
              onClick={() => setModeFilter(f.id)}
              {...sfxProps('uiClick')}
              className='lb-chipbtn'
            >
              {f.label}
            </button>
          ))}
          <button
            type='button'
            aria-pressed={hideFull}
            onClick={() => setHideFull((v) => !v)}
            {...sfxProps('uiClick')}
            className='lb-chipbtn ml-auto'
          >
            Hide full
          </button>
        </div>
      )}
      <div className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1'>
        {failed ? (
          <StateBlock icon={<IconAlert />} title='Server unreachable' tone='rose'>
            Online lobbies are unavailable right now. Solo vs Bots still works offline.
          </StateBlock>
        ) : !online ? (
          <LobbySkeleton />
        ) : rooms.length === 0 ? (
          <StateBlock icon={<IconRadar />} title='No open lobbies'>
            Hit Play to start one, or create a match.
          </StateBlock>
        ) : shown.length === 0 ? (
          <StateBlock icon={<IconRadar />} title={filtering ? 'No lobbies match' : 'No open lobbies'}>
            Clear a filter to see the other lobbies.
          </StateBlock>
        ) : (
          <ul className='flex flex-col gap-2'>
            {shown.map((r) => (
              <RoomCard key={r.id} room={r} onJoin={onJoin} onSpectate={onSpectate} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

export function Avatar({ name, guest, small }: { name: string; guest?: boolean; small?: boolean }) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden='true'
      className={`lb-avatar ${small ? 'lb-avatar-sm' : ''}`}
      data-guest={guest ? 'true' : undefined}
      style={{ ['--h' as string]: hueOf(name) }}
    >
      {initial}
    </span>
  );
}

// "Who's online" tab of the social dock. Registered players are listed by name
// (with staff/verified badges + an in-match dot); guests are shown only as an
// aggregate count (never named — they're anonymous and a name list would be a
// slur vector). All values are server-authoritative.
export function OnlinePlayersPanel({
  presence,
  youName,
}: {
  presence: PresenceState | null;
  youName: string | null;
}) {
  const players: PresencePlayer[] = presence?.players ?? [];
  const guests = presence?.guests ?? 0;
  return (
    <div className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3'>
      <div className='mb-2.5 flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/45'>
        <span className='deck-pulse h-1.5 w-1.5 rounded-full bg-emerald-400' />
        {presence ? `${presence.online} online` : 'Linking…'}
      </div>
      {!presence ? (
        <div className='flex flex-col gap-1.5' aria-busy='true'>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className='h-9 w-full' />
          ))}
        </div>
      ) : players.length === 0 && guests === 0 ? (
        <StateBlock icon={<IconUsers />} title='No one online'>
          Check back in a moment.
        </StateBlock>
      ) : (
        <ul className='flex flex-col gap-1.5'>
          {players.map((p) => {
            const you = !!youName && p.name === youName;
            return (
              <li key={p.name} className='lb-player' data-you={you ? 'true' : undefined}>
                <Avatar name={p.name} />
                <div className='min-w-0 flex-1'>
                  <div className={`flex items-center gap-1.5 text-[13px] font-semibold ${you ? 'text-cyan-100' : 'text-white/90'}`}>
                    <span className='truncate'>{p.name}</span>
                    <NameBadges admin={p.admin} verified={p.verified} size={11} />
                    {you && <span className='shrink-0 text-[9px] uppercase tracking-[0.1em] text-cyan-300/80'>you</span>}
                  </div>
                  <div className='mt-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-white/40'>
                    <span className={`lb-dot ${p.inMatch ? 'bg-amber-400' : 'bg-emerald-400/80'}`} />
                    {p.inMatch ? 'In a match' : 'In the menu'}
                  </div>
                </div>
              </li>
            );
          })}
          {guests > 0 && (
            <li className='lb-player border-dashed'>
              <span className='lb-avatar' data-guest='true' aria-hidden='true'>
                <IconUsers size={14} />
              </span>
              <span className='font-mono text-[10px] uppercase tracking-[0.14em] text-white/50'>
                + {guests} {guests === 1 ? 'guest' : 'guests'}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

// Live global chat (one room) — the social dock's Chat tab. Identity + content
// are server-authoritative and server-moderated (sanitized, length-capped,
// profanity-filtered, rate-limited); we render names/text as React text nodes,
// so they're escaped — no raw HTML.
export function GlobalChatPanel({
  messages,
  online,
  canChat,
  youName,
  onSend,
}: {
  messages: ChatMessage[];
  online: boolean;
  canChat: boolean; // false for guests — they can read but not send
  youName: string | null;
  onSend: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Stick to the newest message as the log grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const canSend = online && canChat;
  const submit = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
    onSend(text.slice(0, CHAT_CLIENT_MAX_LEN));
    setDraft('');
  };

  return (
    <>
      <div ref={scrollRef} className='deck-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3' role='log' aria-label='Global chat'>
        {messages.length === 0 ? (
          <StateBlock icon={<IconChat />} title={online ? 'No messages yet' : 'Linking to server…'}>
            {online ? 'Say hi.' : undefined}
          </StateBlock>
        ) : (
          <div className='flex flex-col gap-2'>
            {messages.map((m) => {
              const mine = !!youName && !m.guest && m.name === youName;
              return (
                <div key={m.id} className='lb-msg' data-mine={mine ? 'true' : undefined}>
                  <Avatar name={m.name} guest={m.guest} small />
                  <div className='lb-bubble'>
                    <span
                      className={`mr-1.5 inline-flex items-center gap-0.5 font-display text-[12px] font-semibold ${
                        m.guest ? 'text-white/45' : mine ? 'text-cyan-200' : 'text-cyan-300/90'
                      }`}
                    >
                      {m.name}
                      <NameBadges admin={m.admin} verified={m.verified} size={11} />
                    </span>
                    <span className='break-words text-white/85'>{m.text}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className='flex shrink-0 items-center gap-2 border-t border-white/10 p-2'>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={CHAT_CLIENT_MAX_LEN}
          disabled={!canSend}
          aria-label='Chat message'
          placeholder={!online ? 'Offline' : !canChat ? 'Log in to chat' : 'Message everyone…'}
          className='lb-chat-input'
        />
        <DeckButton
          onClick={submit}
          disabled={!canSend || draft.trim().length === 0}
          solid
          accent='cyan'
          size='sm'
          center
          className='shrink-0'
          sound='uiClick'
        >
          Send
        </DeckButton>
      </div>
    </>
  );
}
