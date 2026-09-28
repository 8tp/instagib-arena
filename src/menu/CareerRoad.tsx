import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { DeckButton, ModalShell } from '../deck';
import { prefersReducedMotion } from '../deck-core';
import { cosmeticById } from '../game/cosmetics';
import { MAX_LEVEL } from '../game/progression';
import { RewardTile } from './RewardTile';
import { careerRoad, rewardText, xpFraction, type MenuProfile, type RoadNode } from './road-data';
import './menu.css';

// The Career Road: a battle-pass track of levels 1–100. Each node shows what
// that level grants; reached levels are claimed (rewards are granted on
// level-up), the next one is in progress, the rest are locked. Opens scrolled
// to your level; drag, wheel, arrow keys or the scrollbar move along it.
// Reward tiles only mount near the viewport (thumbnails are rendered stills).

const NODE_W = 128;
const PAD = 40;
const TILE = 92;
const TILE_2 = 70; // two rewards on one level stack smaller
const MOUNT_MARGIN = 4; // nodes beyond the viewport that still mount tiles

function CheckGlyph() {
  return (
    <svg width={11} height={11} viewBox='0 0 16 16' aria-hidden='true'>
      <path d='M2.5 8.5l3.5 3.5 7.5-8' fill='none' stroke='currentColor' strokeWidth='2.8' strokeLinecap='square' />
    </svg>
  );
}

function nodeState(n: RoadNode, level: number): 'claimed' | 'next' | 'locked' {
  if (n.level <= level) return 'claimed';
  if (n.level === level + 1) return 'next';
  return 'locked';
}

function nodeLabel(n: RoadNode, state: string): string {
  const what = n.rewards.length
    ? n.rewards.map((r) => rewardText(r, (id) => cosmeticById(id)?.name)).join(', ')
    : 'no rewards yet';
  return `Level ${n.level}: ${what}. ${state === 'claimed' ? 'Unlocked' : state === 'next' ? 'Next level' : 'Locked'}.`;
}

export function CareerRoad({
  profile,
  guest,
  reduced,
  onClose,
  onLogin,
}: {
  profile: MenuProfile | null;
  guest: boolean;
  reduced: boolean;
  onClose: () => void;
  onLogin: () => void;
}) {
  const road = careerRoad();
  const level = guest ? 1 : (profile?.level ?? 1);
  const maxed = level >= MAX_LEVEL;
  const frac = guest || maxed ? 0 : xpFraction(profile);
  const hereX = PAD + (level - 1 + frac) * NODE_W + NODE_W / 2;
  const trackW = PAD * 2 + road.length * NODE_W;
  const noRoad = road.every((n) => n.rewards.length === 0);
  const toNext = profile && !maxed ? Math.max(0, profile.xpForNext - profile.xpIntoLevel) : 0;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<[number, number]>([0, 12]);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; left: number; id: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const rafRef = useRef(0);
  const smooth = !reduced && !prefersReducedMotion();

  const syncRange = useCallback(() => {
    rafRef.current = 0;
    const el = scrollerRef.current;
    if (!el) return;
    const first = Math.floor((el.scrollLeft - PAD) / NODE_W) - MOUNT_MARGIN;
    const last = Math.ceil((el.scrollLeft + el.clientWidth - PAD) / NODE_W) + MOUNT_MARGIN;
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
  }, []);
  const onScroll = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(syncRange);
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const scrollToLevel = useCallback(
    (glide: boolean) => {
      const el = scrollerRef.current;
      if (!el) return;
      const target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, hereX - el.clientWidth * 0.36));
      if (glide && smooth) el.scrollTo({ left: target, behavior: 'smooth' });
      else el.scrollLeft = target;
      syncRange();
    },
    [hereX, smooth, syncRange],
  );

  // Open on your level: a short glide in from a little way back.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = Math.max(0, hereX - el.clientWidth * 0.36);
    el.scrollLeft = smooth ? Math.max(0, target - el.clientWidth * 0.5) : target;
    syncRange();
    if (smooth) {
      const id = window.setTimeout(() => scrollToLevel(true), 180);
      return () => window.clearTimeout(id);
    }
    return undefined;
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Vertical wheel → horizontal travel (non-passive so the page doesn't eat it).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || e.button !== 0) return; // touch scrolls natively
    const el = scrollerRef.current;
    if (!el) return;
    drag.current = { x: e.clientX, left: el.scrollLeft, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = scrollerRef.current;
    if (!d || !el || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true;
      setDragging(true);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
    }
    if (d.moved) el.scrollLeft = d.left - dx;
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.moved) return;
    suppressClick.current = true;
    setDragging(false);
    try {
      scrollerRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = scrollerRef.current;
    if (!el) return;
    const by = (dx: number) => el.scrollBy({ left: dx, behavior: smooth ? 'smooth' : 'auto' });
    if (e.key === 'ArrowRight') by(NODE_W * 2);
    else if (e.key === 'ArrowLeft') by(-NODE_W * 2);
    else if (e.key === 'PageDown') by(el.clientWidth * 0.85);
    else if (e.key === 'PageUp') by(-el.clientWidth * 0.85);
    else if (e.key === 'Home') el.scrollTo({ left: 0, behavior: smooth ? 'smooth' : 'auto' });
    else if (e.key === 'End') el.scrollTo({ left: el.scrollWidth, behavior: smooth ? 'smooth' : 'auto' });
    else return;
    e.preventDefault();
  };

  const header = (
    <div className='flex flex-wrap items-center gap-x-6 gap-y-3'>
      <div className='flex items-baseline gap-2'>
        <span className='font-mono text-[11px] text-white/45'>Level</span>
        <span className='road-stat text-cyan-100'>{level}</span>
        <span className='font-mono text-[11px] text-white/35'>/ {MAX_LEVEL}</span>
      </div>
      {guest ? (
        <div className='flex min-w-0 flex-1 flex-wrap items-center gap-3'>
          <p className='font-sans text-[13px] text-white/60'>Log in to start your road — every level you reach unlocks its rewards.</p>
          <DeckButton onClick={onLogin} accent='cyan' solid size='sm'>
            Log in
          </DeckButton>
        </div>
      ) : (
        <div className='flex min-w-[14rem] flex-1 flex-col gap-1.5'>
          <div className='menu-xp'>
            <span style={{ width: `${(maxed ? 1 : frac) * 100}%` }} />
          </div>
          <div className='flex justify-between gap-3 font-mono text-[11px] tabular-nums text-white/50'>
            <span>
              {maxed
                ? `${(profile?.totalXp ?? 0).toLocaleString()} XP`
                : `${(profile?.xpIntoLevel ?? 0).toLocaleString()} / ${(profile?.xpForNext ?? 0).toLocaleString()} XP`}
            </span>
            <span>{maxed ? 'Max level' : `${toNext.toLocaleString()} XP to level ${level + 1}`}</span>
          </div>
        </div>
      )}
      <DeckButton onClick={() => scrollToLevel(true)} size='sm' className='shrink-0'>
        Jump to my level
      </DeckButton>
    </div>
  );

  return (
    <ModalShell
      title='Career Road'
      width='w-[min(1240px,96vw)]'
      tone='cyan'
      onClose={onClose}
      header={header}
      padded={false}
      footer={
        <p className='font-sans text-[12px] leading-snug text-white/45'>
          {noRoad
            ? 'Road rewards are on the way. Levels shown with an item already unlock it.'
            : 'Reach a level and its rewards are yours — nothing to claim.'}
          <span className='ml-2 text-white/30 max-sm:hidden'>Drag, scroll or use the arrow keys to travel.</span>
        </p>
      }
    >
      <div
        ref={scrollerRef}
        role='region'
        aria-label='Career Road levels'
        tabIndex={0}
        data-dragging={dragging ? '1' : '0'}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClickCapture={(e) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            e.stopPropagation();
            e.preventDefault();
          }
        }}
        onKeyDown={onKeyDown}
        className='road-scroller'
      >
        <div
          className='road-track pb-5 pt-[1.9rem]'
          style={{ width: trackW, ['--road-pad' as string]: `${PAD}px`, ['--rail-y' as string]: 'calc(1.9rem + 2.6rem + 1.1rem)' }}
        >
          <div aria-hidden='true' className='road-rail' />
          <div aria-hidden='true' className='road-rail-fill' style={{ width: hereX }} />
          <div aria-hidden='true' className='road-here' style={{ left: hereX, height: 'calc(1.9rem + 2.6rem + 0.6rem)' }}>
            <span className='road-here-flag'>{guest ? 'Start' : 'You'}</span>
            <span className='road-here-stem' />
          </div>
          {road.map((n, i) => {
            const state = nodeState(n, level);
            const near = i >= range[0] && i <= range[1];
            const shown = n.rewards.slice(0, 2);
            const size = shown.length > 1 ? TILE_2 : TILE;
            return (
              <div
                key={n.level}
                role='group'
                aria-label={nodeLabel(n, state)}
                className='road-node'
                data-state={state}
                data-milestone={n.level % 10 === 0 ? '1' : '0'}
                style={{ width: NODE_W }}
              >
                <div className='road-lv'>
                  <small>LV</small>
                  {n.level}
                </div>
                <div className='road-pip-row'>
                  <span className='road-pip' />
                </div>
                <div className='road-rewards'>
                  {shown.length === 0 ? (
                    <div className='road-empty' style={{ width: TILE, height: TILE }}>
                      {n.level === 1 ? 'Your start' : 'Rewards coming'}
                    </div>
                  ) : (
                    shown.map((r, k) =>
                      near ? (
                        <div key={k} className='relative'>
                          <RewardTile reward={r} size={size} locked={state === 'locked'} />
                          {state === 'claimed' && (
                            <span className='road-owned' title='Unlocked'>
                              <CheckGlyph />
                            </span>
                          )}
                        </div>
                      ) : (
                        <div key={k} className='bg-white/[0.03]' style={{ width: size, height: size }} />
                      ),
                    )
                  )}
                  {n.rewards.length > 2 && (
                    <span className='font-mono text-[10px] text-white/45'>+{n.rewards.length - 2} more</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ModalShell>
  );
}
