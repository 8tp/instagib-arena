import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DeckButton, ModalShell, UtilButton } from '../deck';
import { CONTROLS } from '../controls';
import { inviteLink } from './helpers';
import { IconAlert, IconCheck, IconCopy, IconCrosshair, IconRadar, IconWifiOff } from './shared';
import './lobby.css';

// Centred state header: an icon tile, a status eyebrow, a title and a message.
function StateHeader({
  icon,
  tone,
  eyebrow,
  title,
  children,
  ping,
}: {
  icon: ReactNode;
  tone: 'cyan' | 'rose' | 'amber' | 'emerald';
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  ping?: boolean;
}) {
  const eyebrowColor = tone === 'rose' ? 'text-rose-200' : tone === 'amber' ? 'text-amber-200' : 'text-cyan-200';
  const dot = tone === 'rose' ? 'bg-rose-300' : tone === 'amber' ? 'bg-amber-300' : 'bg-cyan-300';
  return (
    <div className='flex flex-col items-center gap-3 text-center'>
      <span className={`lb-hero-icon ${ping ? 'lb-ping' : ''}`} data-tone={tone}>
        {icon}
      </span>
      {eyebrow && (
        <div className={`flex items-center justify-center gap-2 text-[11px] uppercase tracking-[0.3em] ${eyebrowColor}`}>
          <span className={`deck-pulse inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
          {eyebrow}
        </div>
      )}
      <div className='font-display text-xl font-bold uppercase tracking-[0.12em] text-white'>{title}</div>
      {children && <p className='max-w-[22rem] font-sans text-sm leading-relaxed text-white/60'>{children}</p>}
    </div>
  );
}

// First-run welcome: pick a display name + a quick controls primer. Shown once
// (guarded by the `instagib-onboarded` localStorage flag).
export function OnboardingModal({
  onPlayGuest,
  onCreateAccount,
}: {
  onPlayGuest: () => void;
  onCreateAccount: () => void;
}) {
  // Escape / backdrop = play as guest (every other modal is escapable). The
  // drifting deck grid inside the sheet is this dialog's one flourish — it is
  // the first thing a new player sees.
  return (
    <ModalShell
      onClose={onPlayGuest}
      label='Welcome to the Arena'
      fixed
      z='z-[60]'
      size='lg'
      className='deck-bg'
      scroll
      footer={({ close }) => (
        <>
          <DeckButton onClick={close} size='sm' center sound='uiBack'>
            Play as Guest
          </DeckButton>
          <DeckButton onClick={onCreateAccount} solid accent='emerald' center>
            Create account
          </DeckButton>
        </>
      )}
    >
      <div className='flex flex-col items-center gap-2 pt-1 text-center'>
        <span className='lb-hero-icon' data-tone='cyan'>
          <IconCrosshair size={30} />
        </span>
        <div className='deck-label !text-cyan-200/80'>Welcome to</div>
        <h2 className='font-display text-3xl font-bold uppercase leading-none tracking-[0.08em] text-white'>
          Instagib Arena
        </h2>
        <p className='font-display text-sm font-semibold uppercase tracking-[0.24em] text-white/80'>
          One railgun. One shot. Pure movement.
        </p>
      </div>
      <div>
        <div className='deck-label'>Controls</div>
        <div className='mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2'>
          {CONTROLS.map(([key, action]) => (
            <div key={key} className='flex items-baseline gap-2.5 text-[12px]'>
              <kbd className='deck-kbd'>{key}</kbd>
              <span className='font-sans text-white/60'>{action}</span>
            </div>
          ))}
        </div>
      </div>
      <p className='border-t border-white/10 pt-4 font-sans text-[13px] leading-relaxed text-white/55'>
        Jump in as a <span className='text-white/85'>guest</span> right now — or create a free account
        to save your XP, levels, credits, and cosmetics and climb the leaderboards.
      </p>
    </ModalShell>
  );
}

// Online + the connection dropped mid-match: tell the player the game stalled
// and is auto-retrying, instead of leaving them in a silent "ghost match".
export function DisconnectedOverlay({ error, onLeave }: { error: boolean; onLeave: () => void }) {
  return (
    <ModalShell label='Connection lost' tone='rose' z='z-30' backdrop='heavy' bodyClassName='items-center text-center'>
      <StateHeader
        tone='rose'
        icon={<IconWifiOff size={28} />}
        eyebrow={error ? 'Connection error' : 'Connection lost'}
        title='Reconnecting…'
      >
        Lost contact with the server. Trying to get you back into the match — this usually takes a
        few seconds.
      </StateHeader>
      <DeckButton onClick={onLeave} size='sm' center sound='uiBack'>
        Leave to menu
      </DeckButton>
    </ModalShell>
  );
}

// Online + alone: instead of a silent empty arena, show what's happening and a
// one-click way to fill the lobby (#6a).
export function WaitingForOpponents({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const link = inviteLink(roomId);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <ModalShell label='Waiting for opponents' z='z-30' width='w-[460px]' backdrop='heavy'>
      <StateHeader tone='cyan' icon={<IconRadar size={28} />} ping eyebrow='Waiting for opponents' title="You're the only one here">
        The match starts the moment another player joins. Share the link to fill the lobby.
      </StateHeader>
      <div className='flex flex-col gap-2'>
        <div className='lb-copy-row'>
          <input
            readOnly
            value={link}
            aria-label='Invite link'
            onFocus={(e) => e.currentTarget.select()}
            className='deck-input deck-input-sm min-w-0 flex-1'
          />
          <UtilButton onClick={copy} tone='cyan' sound='uiConfirm' className='inline-flex shrink-0 items-center gap-1.5'>
            {copied ? <IconCheck /> : <IconCopy />}
            <span aria-live='polite'>{copied ? 'Copied!' : 'Copy'}</span>
          </UtilButton>
        </div>
        {roomId && (
          <div className='lb-field-label !justify-start gap-2'>
            Lobby code <b>{roomId}</b>
          </div>
        )}
      </div>
      <DeckButton onClick={onLeave} full center sound='uiBack'>
        Leave to Lobby
      </DeckButton>
    </ModalShell>
  );
}

export function JoinErrorOverlay({
  message,
  onLeave,
  onRetry,
}: {
  message: string;
  onLeave: () => void;
  onRetry?: () => void;
}) {
  return (
    <ModalShell label="Couldn't join" tone='rose' z='z-40' size='sm' backdrop='heavy'>
      <StateHeader tone='rose' icon={<IconAlert size={28} />} title="Couldn't join">
        {message}
      </StateHeader>
      <div className='flex gap-3'>
        {onRetry && (
          <DeckButton onClick={onRetry} solid accent='emerald' center className='flex-1'>
            Try Again
          </DeckButton>
        )}
        <DeckButton onClick={onLeave} solid={!onRetry} accent={onRetry ? 'plain' : 'emerald'} center className='flex-1' sound='uiBack'>
          Back to Lobby
        </DeckButton>
      </div>
    </ModalShell>
  );
}
