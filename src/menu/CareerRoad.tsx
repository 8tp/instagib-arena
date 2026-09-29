import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { MODAL_EXIT_MS, prefersReducedMotion, sfxProps, uiSfx, useModalStack } from '../deck-core';
import { cosmeticById } from '../game/cosmetics';
import { MAX_LEVEL, type RoadReward } from '../game/progression';
import { Credits, LevelEmblem, XpBar } from './Progress';
import { KeyGlyph, RewardTile } from './RewardTile';
import { RoadPreview, type PreviewLoadout } from './RoadPreview';
import { careerRoad, nextRoadStep, rewardKind, rewardText, xpFraction, type MenuProfile, type RoadNode } from './road-data';
import './menu.css';

// The Career Road: a full-screen battle-pass place (same shell as the Locker).
// Left: a big preview of the selected reward (the next one by default).
// Right: the track of levels 1–100 — each node is the level emblem on the rail
// with its rewards as full-size tiles underneath; reached levels are unlocked
// (rewards are granted on level-up), the next one is in progress, the rest are
// locked. Opens scrolled to your level; drag, wheel, arrows (buttons or keys).
// Reward tiles only mount near the viewport (thumbnails are rendered stills).

const TILE = 164;
const GAP = 12;
const NODE_PAD = 36;
const PAD = 64; // track padding at both ends (room for the fade + arrows)
const MOUNT_MARGIN = 700; // px beyond the viewport that still mount tiles

type Sel = { level: number; index: number };

function nodeState(n: RoadNode, level: number): 'claimed' | 'next' | 'locked' {
  if (n.level <= level) return 'claimed';
  if (n.level === level + 1) return 'next';
  return 'locked';
}

function nameOf(r: RoadReward): string {
  return rewardText(r, (id) => cosmeticById(id)?.name);
}

function CheckGlyph() {
  return (
    <svg width={12} height={12} viewBox='0 0 16 16' aria-hidden='true'>
      <path d='M2.5 8.5l3.5 3.5 7.5-8' fill='none' stroke='currentColor' strokeWidth='2.8' strokeLinecap='square' />
    </svg>
  );
}

function Arrow({ dir }: { dir: -1 | 1 }) {
  return (
    <svg width={18} height={18} viewBox='0 0 24 24' aria-hidden='true'>
      <path d={dir < 0 ? 'M15 4l-8 8 8 8' : 'M9 4l8 8-8 8'} fill='none' stroke='currentColor' strokeWidth='2.6' strokeLinecap='square' />
    </svg>
  );
}

export function CareerRoad({
  profile,
  guest,
  reduced,
  lowSpec = false,
  loadout,
  onClose,
  onLogin,
}: {
  profile: MenuProfile | null;
  guest: boolean;
  reduced: boolean;
  lowSpec?: boolean;
  loadout: PreviewLoadout;
  onClose: () => void;
  onLogin: () => void;
}) {
  const road = careerRoad();
  const level = guest ? 1 : (profile?.level ?? 1);
  const maxed = level >= MAX_LEVEL;
  const frac = guest || maxed ? 0 : xpFraction(profile);
  const toNext = profile && !guest && !maxed ? Math.max(0, profile.xpForNext - profile.xpIntoLevel) : 0;
  const smooth = !reduced && !prefersReducedMotion();

  // Node geometry: variable width (one tile per reward, side by side).
  const geo = useMemo(() => {
    const widths = road.map((n) => Math.max(1, n.rewards.length) * TILE + (Math.max(1, n.rewards.length) - 1) * GAP + NODE_PAD);
    const lefts: number[] = [];
    let x = PAD;
    for (const w of widths) {
      lefts.push(x);
      x += w;
    }
    return { widths, lefts, total: x + PAD };
  }, [road]);
  const centerOf = useCallback((lv: number) => {
    const i = Math.max(0, Math.min(road.length - 1, lv - 1));
    return geo.lefts[i] + geo.widths[i] / 2;
  }, [geo, road.length]);
  const hereX = maxed ? centerOf(level) : centerOf(level) + frac * (centerOf(level + 1) - centerOf(level));

  const initial = nextRoadStep(level) ?? road[Math.min(road.length - 1, level - 1)];
  // "Coming up": the next five named cosmetics ahead (epic / legendary first,
  // then the nearest rares) — never a row of identical free rolls.
  const milestones = useMemo(() => {
    const RANK: Record<string, number> = { legendary: 3, epic: 2, rare: 1, common: 0 };
    const ahead: { level: number; index: number; reward: RoadReward; rank: number }[] = [];
    for (const n of road) {
      if (n.level <= level) continue;
      n.rewards.forEach((r, index) => {
        if (r.type !== 'cosmetic') return;
        const c = cosmeticById(r.id);
        if (c) ahead.push({ level: n.level, index, reward: r, rank: RANK[c.rarity] ?? 0 });
      });
    }
    const window = ahead.slice(0, 18);
    return [...window].sort((a, b) => b.rank - a.rank || a.level - b.level).slice(0, 5).sort((a, b) => a.level - b.level);
  }, [road, level]);
  const [sel, setSel] = useState<Sel>({ level: initial.level, index: 0 });
  const selNode = road[sel.level - 1];
  const selReward: RoadReward | undefined = selNode?.rewards[sel.index] ?? selNode?.rewards[0];
  const selState = selNode ? nodeState(selNode, level) : 'locked';

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<[number, number]>([0, 1600]);
  const [ends, setEnds] = useState<[boolean, boolean]>([true, false]);
  const [dragging, setDragging] = useState(false);
  const [closing, setClosing] = useState(false);
  const drag = useRef<{ x: number; left: number; id: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const rafRef = useRef(0);

  // ── Shell: modal stack (pauses the menu backdrop), Esc, focus ────────────
  const isTop = useModalStack();
  const close = useCallback(() => {
    if (closing) return;
    uiSfx('uiBack');
    if (!smooth) {
      onClose();
      return;
    }
    setClosing(true);
    window.setTimeout(onClose, MODAL_EXIT_MS);
  }, [closing, smooth, onClose]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isTop()) return;
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = rootRef.current;
      if (!root) return;
      const els = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (el) => el.getClientRects().length > 0,
      );
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      const a = document.activeElement;
      const inside = a instanceof Node && root.contains(a);
      if (e.shiftKey ? !inside || a === first : !inside || a === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isTop, close]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  }, []);

  // ── Track scrolling ──────────────────────────────────────────────────────
  const sync = useCallback(() => {
    rafRef.current = 0;
    const el = scrollerRef.current;
    if (!el) return;
    setView((v) => (Math.abs(v[0] - el.scrollLeft) < 60 && v[1] === el.clientWidth ? v : [el.scrollLeft, el.clientWidth]));
    const max = el.scrollWidth - el.clientWidth;
    setEnds((e) => {
      const next: [boolean, boolean] = [el.scrollLeft <= 2, el.scrollLeft >= max - 2];
      return e[0] === next[0] && e[1] === next[1] ? e : next;
    });
  }, []);
  const onScroll = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(sync);
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const scrollToX = useCallback(
    (x: number, glide: boolean) => {
      const el = scrollerRef.current;
      if (!el) return;
      const target = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, x - el.clientWidth * 0.34));
      if (glide && smooth) el.scrollTo({ left: target, behavior: 'smooth' });
      else el.scrollLeft = target;
      sync();
    },
    [smooth, sync],
  );

  // Open on your level: a short glide in from a little way back.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const target = Math.max(0, hereX - el.clientWidth * 0.34);
    el.scrollLeft = smooth ? Math.max(0, target - el.clientWidth * 0.45) : target;
    sync();
    if (!smooth) return undefined;
    const id = window.setTimeout(() => scrollToX(hereX, true), 200);
    return () => window.clearTimeout(id);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY * (e.deltaMode === 1 ? 32 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, [sync]);

  const page = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: smooth ? 'smooth' : 'auto' });
  };

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
    if (e.key === 'ArrowRight') by(TILE * 1.5);
    else if (e.key === 'ArrowLeft') by(-TILE * 1.5);
    else if (e.key === 'PageDown') by(el.clientWidth * 0.85);
    else if (e.key === 'PageUp') by(-el.clientWidth * 0.85);
    else if (e.key === 'Home') el.scrollTo({ left: 0, behavior: smooth ? 'smooth' : 'auto' });
    else if (e.key === 'End') el.scrollTo({ left: el.scrollWidth, behavior: smooth ? 'smooth' : 'auto' });
    else return;
    e.preventDefault();
  };

  const pick = (lv: number, index: number) => {
    uiSfx('uiClick');
    setSel({ level: lv, index });
  };
  const jumpTo = (lv: number, index = 0) => {
    pick(lv, index);
    scrollToX(centerOf(lv), true);
  };

  // ── Preview copy ─────────────────────────────────────────────────────────
  const status = !selNode
    ? ''
    : guest
      ? `Unlocks at level ${selNode.level}`
      : selState === 'claimed'
        ? `Unlocked at level ${selNode.level}`
        : selState === 'next' && toNext > 0
          ? `Level ${selNode.level} · ${toNext.toLocaleString()} XP to go`
          : `Unlocks at level ${selNode.level}`;

  const [vl, vw] = view;
  const node = (
    <div
      ref={rootRef}
      role='dialog'
      aria-modal='true'
      aria-label='Career Road'
      tabIndex={-1}
      className={`road-root ${closing ? 'road-exit' : 'road-enter'} ${smooth ? '' : 'road-reduced'}`}
    >
      <header className='road-top'>
        <h2 className='road-title'>Career Road</h2>
        <div className='flex min-w-0 flex-1 items-center gap-4'>
          <LevelEmblem level={level} size={56} tone={guest ? 'guest' : 'you'} />
          {guest ? (
            <div className='flex min-w-0 flex-wrap items-center gap-3'>
              <span className='font-sans text-[14px] text-white/65'>Every level you reach unlocks its rewards.</span>
              <button type='button' onClick={onLogin} {...sfxProps('uiConfirm')} className='menu-cta'>
                Log in to start
              </button>
            </div>
          ) : (
            <div className='flex w-full max-w-[34rem] flex-col gap-1.5'>
              <XpBar frac={maxed ? 1 : frac} height={12} />
              <div className='flex justify-between gap-3 font-sans text-[13px] tabular-nums text-white/60'>
                <span>
                  {maxed
                    ? `${(profile?.totalXp ?? 0).toLocaleString()} XP`
                    : `${(profile?.xpIntoLevel ?? 0).toLocaleString()} / ${(profile?.xpForNext ?? 0).toLocaleString()} XP`}
                </span>
                <span>{maxed ? 'Max level' : `${toNext.toLocaleString()} XP to level ${level + 1}`}</span>
              </div>
            </div>
          )}
        </div>
        {!guest && profile && (
          <div className='flex items-center gap-4'>
            <Credits amount={profile.credits} className='road-credits' />
            {(profile.freeRolls ?? profile.caseKeys ?? 0) > 0 && (
              <span className='menu-door-keys' title='Free case rolls'>
                <KeyGlyph size={15} /> {profile.freeRolls ?? profile.caseKeys}
              </span>
            )}
          </div>
        )}
        <button type='button' className='road-close' onClick={close} aria-label='Close the Career Road' {...sfxProps('none')}>
          ✕ ESC
        </button>
      </header>

      <div className='road-body'>
        {/* ── Preview of the selected reward ─────────────────────────── */}
        <section className='road-preview' aria-live='polite'>
          {selReward ? (
            <>
              <div className='road-stage'>
                <RoadPreview
                  reward={selReward}
                  loadout={loadout}
                  locked={guest || selState === 'locked'}
                  lowSpec={lowSpec}
                  reduced={!smooth}
                />
              </div>
              <div className='road-preview-info'>
                <div className='flex items-start gap-4'>
                  <LevelEmblem level={selNode.level} size={52} tone={selState === 'claimed' && !guest ? 'you' : 'locked'} />
                  <div className='min-w-0'>
                    <h3 className='road-preview-name'>{nameOf(selReward)}</h3>
                    <p className='mt-1 font-sans text-[14px] text-white/65'>{rewardKind(selReward)}</p>
                  </div>
                </div>
                <p className={`mt-3 font-sans text-[15px] ${selState === 'claimed' && !guest ? 'text-cyan-200' : 'text-white/80'}`}>
                  {selState === 'claimed' && !guest && (
                    <span className='mr-1.5 inline-block align-[-1px] text-cyan-300'>
                      <CheckGlyph />
                    </span>
                  )}
                  {status}
                </p>
                {selNode.rewards.length > 1 && (
                  <p className='mt-1 font-sans text-[13px] text-white/50'>
                    Also at this level: {selNode.rewards.filter((_, i) => i !== sel.index).map(nameOf).join(', ')}
                  </p>
                )}
                {!guest && (
                  <div className='mt-4'>
                    <button type='button' onClick={() => scrollToX(hereX, true)} {...sfxProps('uiClick')} className='menu-acct-btn'>
                      Jump to my level
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className='p-8 font-sans text-[15px] text-white/55'>Rewards for this level are on the way.</p>
          )}
        </section>

        {/* ── The track ───────────────────────────────────────────────── */}
        <section className='road-trackwrap' aria-label='Levels'>
          <div className='relative'>
          <span aria-hidden='true' className='road-fade road-fade-l' style={{ opacity: ends[0] ? 0 : 1 }} />
          <span aria-hidden='true' className='road-fade road-fade-r' style={{ opacity: ends[1] ? 0 : 1 }} />
          <button type='button' className='road-arrow road-arrow-l' onClick={() => page(-1)} disabled={ends[0]} aria-label='Earlier levels' {...sfxProps('uiClick')}>
            <Arrow dir={-1} />
          </button>
          <button type='button' className='road-arrow road-arrow-r' onClick={() => page(1)} disabled={ends[1]} aria-label='Later levels' {...sfxProps('uiClick')}>
            <Arrow dir={1} />
          </button>
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
            <div className='road-track' style={{ width: geo.total }}>
              <div aria-hidden='true' className='road-rail' />
              <div aria-hidden='true' className='road-rail-fill' style={{ width: hereX }} />
              <div aria-hidden='true' className='road-here' style={{ left: hereX }}>
                <span className='road-here-flag'>{guest ? 'Start' : 'You'}</span>
                <span className='road-here-stem' />
              </div>
              {road.map((n, i) => {
                const state = nodeState(n, level);
                const left = geo.lefts[i];
                const near = left + geo.widths[i] > vl - MOUNT_MARGIN && left < vl + vw + MOUNT_MARGIN;
                return (
                  <div
                    key={n.level}
                    role='group'
                    aria-label={`Level ${n.level}: ${n.rewards.length ? n.rewards.map(nameOf).join(', ') : 'no rewards yet'}. ${
                      state === 'claimed' ? 'Unlocked' : state === 'next' ? 'Next level' : 'Locked'
                    }.`}
                    className='road-node'
                    data-state={state}
                    data-milestone={n.level % 10 === 0 ? '1' : '0'}
                    style={{ width: geo.widths[i] }}
                  >
                    <div className='road-pip-row'>
                      <LevelEmblem level={n.level} size={n.level % 10 === 0 ? 46 : 38} label={false} tone={state === 'locked' || guest ? 'locked' : 'you'} />
                    </div>
                    <div className='road-rewards'>
                      {n.rewards.length === 0 ? (
                        <div className='road-empty' style={{ width: TILE, height: TILE }}>
                          {n.level === 1 ? 'Your start' : 'Rewards coming'}
                        </div>
                      ) : (
                        n.rewards.map((r, k) =>
                          near ? (
                            <div key={k} className='relative'>
                              <RewardTile
                                reward={r}
                                size={TILE}
                                locked={guest || state === 'locked'}
                                selected={sel.level === n.level && sel.index === k}
                                onClick={() => pick(n.level, k)}
                              />
                              {state === 'claimed' && !guest && (
                                <span className='road-owned' title='Unlocked'>
                                  <CheckGlyph />
                                </span>
                              )}
                            </div>
                          ) : (
                            <div key={k} className='bg-white/[0.03]' style={{ width: TILE, height: TILE }} />
                          ),
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </div>
          <p className='road-hint'>Reach a level and its rewards are yours. Drag, scroll or use the arrow keys to travel.</p>
          {milestones.length > 0 && (
            <div className='road-coming'>
              <h3 className='road-coming-title'>Coming up</h3>
              <div className='flex flex-wrap gap-4'>
                {milestones.map((m) => (
                  <div key={`${m.level}:${m.index}`} className='flex w-[112px] flex-col items-start gap-1'>
                    <RewardTile
                      reward={m.reward}
                      size={112}
                      label={false}
                      selected={sel.level === m.level && sel.index === m.index}
                      onClick={() => jumpTo(m.level, m.index)}
                    />
                    <span className='mt-0.5 w-full truncate font-sans text-[13px] font-medium text-white/85'>{nameOf(m.reward)}</span>
                    <span className='font-sans text-[12px] text-white/50'>Level {m.level}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
}
