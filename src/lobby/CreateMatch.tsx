import { useRef, useState } from 'react';
import { DeckButton, ModalShell, SegButton, UtilButton } from '../deck';
import { toast } from '../deck-core';
import type { Settings } from '../app-types';
import type { MatchConfig } from '../InstagibClient';
import { GAME_MODES, MAX_PLAYERS, type BotDifficulty, type GameMode } from '../game/constants';
import { MAPS } from '../game/map';
import { ONLINE_MAP_POOL } from '../game/arena-data';
import { inviteLink } from './helpers';
import { IconCopy, MapPicker } from './shared';
import './lobby.css';

const ONLINE_MAP_IDS: readonly string[] = ONLINE_MAP_POOL;

// Mode selector: three cards, each with the mode's blurb. `labels` lets the
// solo dialog keep its shorter names.
function ModePicker({
  value,
  onChange,
  labels,
}: {
  value: GameMode;
  onChange: (m: GameMode) => void;
  labels?: Partial<Record<GameMode, string>>;
}) {
  return (
    <div className='flex flex-col gap-2'>
      <div className='lb-field-label'>
        <span>Game mode</span>
      </div>
      <div className='grid grid-cols-1 gap-2 sm:grid-cols-3' role='radiogroup' aria-label='Game mode'>
        {GAME_MODES.map((m) => (
          <button
            key={m.id}
            type='button'
            role='radio'
            aria-checked={value === m.id}
            onClick={() => onChange(m.id)}
            className='lb-mode'
          >
            <span className='lb-mode-name'>{labels?.[m.id] ?? m.label}</span>
            <span className='lb-mode-sub'>{m.blurb}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlayersSlider({
  label,
  value,
  display,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  return (
    <label className={`flex flex-col gap-2 ${disabled ? 'opacity-45' : ''}`}>
      <div className='lb-field-label'>
        <span>{label}</span>
        <b className='tabular-nums'>{display}</b>
      </div>
      <input
        type='range'
        min={2}
        max={MAX_PLAYERS}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className='deck-range'
      />
    </label>
  );
}

export function InviteModal({
  roomId,
  onEnter,
  onClose,
}: {
  roomId: string;
  onEnter: () => void;
  onClose: () => void;
}) {
  const link = inviteLink(roomId);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast('Copied invite link', { tone: 'ok' });
    } catch {
      // Clipboard API blocked (insecure context / permission) — select the
      // field so the user can copy manually instead of a silent no-op (#26c).
      inputRef.current?.select();
      toast('Link selected — press Ctrl/⌘+C to copy', { tone: 'warn' });
    }
  };
  return (
    <ModalShell title='Private Match' tone='emerald' onClose={onClose}>
      <p className='font-sans text-sm text-white/60'>
        Share this link with friends — it drops them straight into your lobby.
      </p>
      <div className='flex flex-col gap-2'>
        <div className='lb-field-label'>
          <span>Invite link</span>
        </div>
        <div className='lb-copy-row'>
          <input
            ref={inputRef}
            readOnly
            value={link}
            aria-label='Invite link'
            onFocus={(e) => e.currentTarget.select()}
            className='deck-input deck-input-sm min-w-0 flex-1'
          />
          <UtilButton onClick={copy} tone='cyan' sound='none' className='inline-flex shrink-0 items-center gap-1.5'>
            <IconCopy /> Copy
          </UtilButton>
        </div>
        <div className='lb-field-label !justify-start gap-2'>
          Lobby code <b>{roomId}</b>
        </div>
      </div>
      <DeckButton onClick={onEnter} solid accent='emerald' full center>
        Enter Match
      </DeckButton>
    </ModalShell>
  );
}

export function CreateOnlineModal({
  settings,
  mode,
  onChangeSettings,
  onChangeMode,
  onClose,
  onCreate,
}: {
  settings: Settings;
  mode: GameMode;
  onChangeSettings: (s: Settings) => void;
  onChangeMode: (m: GameMode) => void;
  onClose: () => void;
  onCreate: (opts: { mapId: string; isPublic: boolean; capacity: number; mode: GameMode }) => void;
}) {
  const [players, setPlayers] = useState(MAX_PLAYERS);
  const [mapId, setMapId] = useState(settings.mapId);
  const [isPublic, setIsPublic] = useState(true);

  // Online play has no bots — restrict to the human-friendly online pool.
  const onlineMaps = MAPS.filter((m) => ONLINE_MAP_IDS.includes(m.id));

  // Duel is always 1v1 — force the capacity to 2 regardless of the slider.
  const isDuel = mode === 'duel';
  const capacity = isDuel ? 2 : players;

  const create = () => {
    onChangeSettings({ ...settings, mapId });
    onCreate({ mapId, isPublic, capacity, mode });
  };

  return (
    <ModalShell
      title='Create Match'
      onClose={onClose}
      size='lg'
      scroll
      footer={
        <DeckButton onClick={create} solid accent='emerald' full center>
          {isPublic ? 'Create & Play' : 'Create & Get Link'}
        </DeckButton>
      }
    >
      <ModePicker value={mode} onChange={onChangeMode} />
      <MapPicker label='Arena' maps={onlineMaps} value={mapId} onChange={setMapId} />
      <PlayersSlider
        label={isDuel ? 'Players' : 'Max players'}
        value={capacity}
        display={isDuel ? '1v1 (2 players)' : String(players)}
        disabled={isDuel}
        onChange={setPlayers}
      />
      <div className='flex flex-col gap-2'>
        <div className='lb-field-label'>
          <span>Visibility</span>
        </div>
        <div className='grid grid-cols-2 gap-2' role='group' aria-label='Visibility'>
          <SegButton active={isPublic} onClick={() => setIsPublic(true)}>
            Public
          </SegButton>
          <SegButton active={!isPublic} onClick={() => setIsPublic(false)}>
            Private
          </SegButton>
        </div>
        <div className='lb-note'>
          {isPublic
            ? 'Public matches appear in Open Lobbies for anyone to join.'
            : 'Private matches are invite-only — you’ll get a link to share.'}
        </div>
      </div>
    </ModalShell>
  );
}

export function CreateMatchModal({
  settings,
  onChangeSettings,
  onClose,
  onStart,
}: {
  settings: Settings;
  onChangeSettings: (s: Settings) => void;
  onClose: () => void;
  onStart: (config: MatchConfig) => void;
}) {
  const [players, setPlayers] = useState(MAX_PLAYERS);
  const [mapId, setMapId] = useState(settings.mapId);
  const [difficulty, setDifficulty] = useState<BotDifficulty>(settings.difficulty);
  const [gameMode, setGameMode] = useState<GameMode>('ffa');

  // Duel is always 1v1 (1 bot); FFA/TDM use the slider.
  const effPlayers = gameMode === 'duel' ? 2 : players;

  const start = () => {
    onChangeSettings({ ...settings, mapId, difficulty });
    onStart({
      mode: 'local',
      mapId,
      botCount: Math.max(1, effPlayers - 1),
      difficulty,
      gameMode,
    });
  };

  return (
    <ModalShell
      title='Solo vs Bots'
      tone='amber'
      onClose={onClose}
      size='lg'
      scroll
      footer={
        <DeckButton onClick={start} solid accent='emerald' full center>
          Start Match
        </DeckButton>
      }
    >
      <ModePicker value={gameMode} onChange={setGameMode} labels={{ ffa: 'FFA', tdm: 'TDM', duel: 'Duel' }} />
      <MapPicker label='Arena' maps={MAPS} value={mapId} onChange={setMapId} />
      <PlayersSlider
        label='Players'
        value={effPlayers}
        disabled={gameMode === 'duel'}
        display={
          gameMode === 'duel'
            ? '2 (1 bot · 1v1)'
            : `${effPlayers} (${effPlayers - 1} ${effPlayers - 1 === 1 ? 'bot' : 'bots'}${gameMode === 'tdm' ? ' · 2 teams' : ''})`
        }
        onChange={setPlayers}
      />
      <DifficultyPicker value={difficulty} onChange={setDifficulty} />
    </ModalShell>
  );
}

export function DifficultyPicker({
  value,
  onChange,
}: {
  value: BotDifficulty;
  onChange: (d: BotDifficulty) => void;
}) {
  const opts: BotDifficulty[] = ['easy', 'medium', 'hard'];
  return (
    <div className='flex flex-col gap-2'>
      <div className='lb-field-label'>
        <span>Bot difficulty</span>
      </div>
      <div className='grid grid-cols-3 gap-2' role='group' aria-label='Bot difficulty'>
        {opts.map((o) => (
          <SegButton key={o} active={value === o} onClick={() => onChange(o)}>
            {o}
          </SegButton>
        ))}
      </div>
    </div>
  );
}
