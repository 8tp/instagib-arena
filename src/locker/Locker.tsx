// The Locker: every cosmetic slot, the live 3D preview, credits + the hat case.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Account } from '../auth';
import type { InstagibProfile, Settings } from '../app-types';
import { DeckButton, DeckTab, ModalShell, Skeleton } from '../deck';
import { sfxProps, toast } from '../deck-core';
import { CharacterPreview, type PreviewCosmetics } from '../game/character-preview';
import {
  CARD_STYLES,
  EMOTES,
  HAT_CASE_COST,
  HATS,
  KILL_EFFECTS,
  NAME_COLORS,
  RAIL_COLORS,
  RAILGUN_FINISHES,
  SPAWN_EFFECTS,
  TITLES,
  UNUSUALS,
  caseHats,
  cosmeticById,
  hatById,
  sourceLabel,
  type CosmeticSource,
  type HatCosmetic,
  type KillEffectStyle,
  type Rarity,
} from '../game/cosmetics';
import { CardStatsEditor } from '../ui/player-card';
import { RARITY_STYLE } from '../ui/player-card-data';

type LockerProfile = {
  unlocked: string[];
  credits: number;
  equipped: Record<string, string>;
  level: number;
};

type LockerItem = {
  id: string;
  name: string;
  blurb: string;
  rarity: Rarity;
  source: CosmeticSource;
};
type LockerSlotDef = {
  slot:
    | 'killEffect'
    | 'railColor'
    | 'railgunFinish'
    | 'hat'
    | 'unusual'
    | 'card'
    | 'emote'
    | 'nameColor'
    | 'spawnEffect'
    | 'title';
  label: string;
  items: readonly LockerItem[];
  current: (s: Settings) => string;
  apply: (s: Settings, id: string) => Settings;
};
const LOCKER_SLOTS: LockerSlotDef[] = [
  {
    slot: 'killEffect',
    label: 'Kill Effect',
    items: KILL_EFFECTS,
    current: (s) => s.killEffect,
    apply: (s, id) => ({ ...s, killEffect: id as KillEffectStyle }),
  },
  {
    slot: 'railColor',
    label: 'Rail Beam',
    items: RAIL_COLORS,
    current: (s) => s.railColor,
    apply: (s, id) => ({ ...s, railColor: id }),
  },
  {
    slot: 'railgunFinish',
    label: 'Railgun Finish',
    items: RAILGUN_FINISHES,
    current: (s) => s.railgunFinish,
    apply: (s, id) => ({ ...s, railgunFinish: id }),
  },
  {
    slot: 'spawnEffect',
    label: 'Spawn Effect',
    items: SPAWN_EFFECTS,
    current: (s) => s.spawnEffect,
    apply: (s, id) => ({ ...s, spawnEffect: id }),
  },
  {
    slot: 'hat',
    label: 'Hat',
    items: HATS,
    current: (s) => s.hat,
    apply: (s, id) => ({ ...s, hat: id }),
  },
  {
    slot: 'unusual',
    label: 'Unusual Effect',
    items: UNUSUALS,
    current: (s) => s.unusual,
    apply: (s, id) => ({ ...s, unusual: id }),
  },
  {
    slot: 'nameColor',
    label: 'Name Color',
    items: NAME_COLORS,
    current: (s) => s.nameColor,
    apply: (s, id) => ({ ...s, nameColor: id }),
  },
  {
    slot: 'title',
    label: 'Title',
    items: TITLES,
    current: (s) => s.title,
    apply: (s, id) => ({ ...s, title: id }),
  },
  {
    slot: 'card',
    label: 'Player Card',
    items: CARD_STYLES,
    current: (s) => s.card,
    apply: (s, id) => ({ ...s, card: id }),
  },
  {
    slot: 'emote',
    label: 'Podium Emote',
    items: EMOTES,
    current: (s) => s.emote,
    apply: (s, id) => ({ ...s, emote: id }),
  },
];

// The Locker: pick your equipped cosmetics across every slot. Server-backed —
// owned items can be equipped, credit-priced ones bought, level-gated ones show
// their unlock. Degrades to local-only selection if the profile can't be
// fetched (offline / no backend), so the picker always works.
// Per-tab focus → the preview shows ONE thing, framed for that slot:
//  character = hat + unusual, head-zoomed, slowly turning
//  emote     = the equipped emote on the whole player model
//  weapon    = just the railgun firing the rail beam (colour) into a kill burst
type LockerView = 'character' | 'emote' | 'weapon';

// Live 3D preview of the equipped loadout for a single Locker tab. A fresh
// instance mounts per tab (so only one WebGL context runs at a time).
function LockerPreview({ settings, view }: { settings: Settings; view: LockerView }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const cosmetics = (): PreviewCosmetics => ({
    hatId: settings.hat,
    unusualId: settings.unusual,
    emoteId: settings.emote,
    railColor: settings.railColor,
    railgunFinish: settings.railgunFinish,
    killEffect: settings.killEffect,
    skinSeed: settings.playerName || undefined, // the armour colour others see you in
    view,
  });
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const preview = new CharacterPreview(canvas, cosmetics());
    previewRef.current = preview;
    preview.start();
    const onResize = () => preview.resize();
    window.addEventListener('resize', onResize);
    // Track the canvas box itself so the preview stays crisp when the panel
    // reflows (open/close, tab switch, responsive width) — not just on window
    // resize. rAF-debounced to coalesce layout bursts.
    let pending = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => preview.resize());
    });
    ro.observe(canvas);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(pending);
      ro.disconnect();
      preview.dispose();
      previewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  useEffect(() => {
    previewRef.current?.setCosmetics(cosmetics());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.hat, settings.unusual, settings.emote, settings.railColor, settings.railgunFinish, settings.killEffect, view]);
  return (
    <div className='clip-deck-sm relative h-60 w-full shrink-0 overflow-hidden border border-white/10 bg-gradient-to-b from-[#161d29] to-[#0b0e14]'>
      <canvas ref={ref} className='block h-full w-full' />
      <div className='pointer-events-none absolute bottom-1.5 right-3 text-[9px] uppercase tracking-[0.18em] text-white/35'>
        Live preview
      </div>
    </div>
  );
}

const LOCKER_TABS = [
  { id: 'character', label: 'Character', slots: ['hat', 'unusual', 'nameColor', 'title'], view: 'character' as const },
  { id: 'emote', label: 'Emotes', slots: ['emote'], view: 'emote' as const },
  { id: 'weapon', label: 'Weapon', slots: ['railColor', 'railgunFinish', 'killEffect', 'spawnEffect'], view: 'weapon' as const },
  { id: 'card', label: 'Card', slots: ['card'], view: null },
] as const;
type LockerTab = (typeof LOCKER_TABS)[number]['id'];

export function Locker({
  settings,
  onChange,
  onClose,
  account,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
  account?: Account;
}) {
  const [profile, setProfile] = useState<LockerProfile | null>(null);
  // 'loading' until /api/profile answers: the grid shows a skeleton instead of
  // a flash of "everything owned" that then snaps to locks. 'offline' = no
  // backend → local-only selection (everything equippable, nothing buyable).
  const [profileState, setProfileState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<LockerTab>('character');
  const [caseSpin, setCaseSpin] = useState<{ won: string; dupe: boolean; refund: number } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    fetch('/api/profile', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('no profile'))))
      .then((d: { profile?: InstagibProfile }) => {
        if (!active) return;
        if (!d.profile) {
          setProfileState('offline');
          return;
        }
        const p = d.profile;
        setProfile({
          unlocked: p.unlocked ?? [],
          credits: p.credits ?? 0,
          equipped: p.equipped ?? {},
          level: p.level ?? 1,
        });
        setProfileState('ready');
        // Sync the server's equipped choices into the live game (once, on open).
        let patch: Settings | null = null;
        for (const sl of LOCKER_SLOTS) {
          const eq = p.equipped?.[sl.slot];
          if (eq && eq !== sl.current(settings) && (p.unlocked ?? []).includes(eq)) {
            patch = sl.apply(patch ?? settings, eq);
          }
        }
        if (patch) onChange(patch);
      })
      .catch(() => {
        /* offline / no backend → local-only selection below */
        if (active) setProfileState('offline');
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const owns = (id: string, source: CosmeticSource) =>
    !profile || profile.unlocked.includes(id) || source.type === 'default';

  const itemName = (id: string) => cosmeticById(id)?.name ?? id;

  // `quiet` skips the "Equipped" toast (buy() reports the purchase instead).
  const equip = async (sl: LockerSlotDef, id: string, quiet = false) => {
    if (!profile) {
      onChange(sl.apply(settings, id)); // local-only fallback
      if (!quiet) toast(`Equipped · ${itemName(id)}`, { tone: 'ok' });
      return;
    }
    setBusy(id);
    try {
      const res = await fetch('/api/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ slot: sl.slot, id }),
      });
      const d = (await res.json()) as { ok?: boolean; equipped?: Record<string, string> };
      if (res.ok && d.ok) {
        onChange(sl.apply(settings, id));
        setProfile((p) => (p ? { ...p, equipped: d.equipped ?? p.equipped } : p));
        if (!quiet) toast(`Equipped · ${itemName(id)}`, { tone: 'ok' });
      } else toast('Could not equip that.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const buy = async (sl: LockerSlotDef, id: string) => {
    setBusy(id);
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ id }),
      });
      const d = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        credits?: number;
        unlocked?: string[];
      };
      if (res.ok && d.ok) {
        setProfile((p) =>
          p ? { ...p, credits: d.credits ?? p.credits, unlocked: d.unlocked ?? p.unlocked } : p,
        );
        toast(`Unlocked + equipped · ${itemName(id)}`, { tone: 'ok' });
        await equip(sl, id, true);
      } else toast(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not buy that.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const openCase = async () => {
    if (busy || (profile != null && profile.credits < HAT_CASE_COST)) return;
    setBusy('__case');
    try {
      const res = await fetch('/api/shop/open-case', { method: 'POST', credentials: 'same-origin' });
      const d = (await res.json()) as {
        ok?: boolean;
        reason?: string;
        won?: string;
        dupe?: boolean;
        refund?: number;
        credits?: number;
        unlocked?: string[];
      };
      if (res.ok && d.ok && d.won) {
        // Apply the new credits/unlocked now; the spinner reveals the win.
        setProfile((p) =>
          p ? { ...p, credits: d.credits ?? p.credits, unlocked: d.unlocked ?? p.unlocked } : p,
        );
        setCaseSpin({ won: d.won, dupe: !!d.dupe, refund: d.refund ?? 0 });
      } else toast(d.reason === 'insufficient' ? 'Not enough credits.' : 'Could not open the case.', { tone: 'err' });
    } catch {
      toast('Network error.', { tone: 'err' });
    }
    setBusy(null);
  };

  const active = LOCKER_TABS.find((t) => t.id === tab) ?? LOCKER_TABS[0];
  const slots = LOCKER_SLOTS.filter((sl) => (active.slots as readonly string[]).includes(sl.slot));
  const loading = profileState === 'loading';
  return (
    <>
    <LockerShell tab={tab} setTab={setTab} credits={profile?.credits ?? null} loading={loading} onClose={onClose}>
      <p className='text-[10px] leading-relaxed text-white/35'>
        Cosmetics — purely visual, never affect aim, movement, or hits.
      </p>
      {active.view && <LockerPreview key={active.view} settings={settings} view={active.view} />}
      {tab === 'card' && <CardStatsEditor settings={settings} onChange={onChange} account={account} />}
      {slots.map((sl) => (
        <div key={sl.slot} className='flex flex-col gap-2' aria-busy={loading}>
          <div className='deck-label'>{sl.label}</div>
          {sl.slot === 'hat' && (
            <button
              type='button'
              onClick={openCase}
              disabled={loading || busy === '__case' || (profile != null && profile.credits < HAT_CASE_COST)}
              title={
                profile != null && profile.credits < HAT_CASE_COST
                  ? `Need ${HAT_CASE_COST - profile.credits} more credits — earn them by playing online matches`
                  : undefined
              }
              {...sfxProps('uiConfirm')}
              className='clip-deck-sm flex items-center justify-center gap-2 border border-amber-300/50 bg-gradient-to-r from-fuchsia-500/15 to-amber-400/15 px-3 py-2.5 font-display text-[12px] font-bold uppercase tracking-[0.14em] text-amber-100 transition hover:from-fuchsia-500/25 hover:to-amber-400/25 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40'
            >
              🎁{' '}
              {busy === '__case'
                ? 'Opening…'
                : profile != null && profile.credits < HAT_CASE_COST
                  ? `Need ${HAT_CASE_COST - profile.credits} more ⛁`
                  : `Open Hat Case · ${HAT_CASE_COST} ⛁`}
            </button>
          )}
          <div className='grid grid-cols-2 gap-2'>
            {loading
              ? sl.items.slice(0, 4).map((item) => <LockerItemSkeleton key={item.id} />)
              : sl.items.map((item) => {
              const equipped = sl.current(settings) === item.id;
              const owned = owns(item.id, item.source);
              const buyable = !owned && item.source.type === 'credits';
              const affordable =
                !owned &&
                item.source.type === 'credits' &&
                profile != null &&
                profile.credits >= item.source.price;
              const working = busy === item.id;
              return (
                <div
                  key={item.id}
                  data-cosmetic={item.id}
                  data-state={equipped ? 'equipped' : owned ? 'owned' : buyable ? 'buyable' : 'locked'}
                  className={`deck-card flex flex-col px-3 py-2.5 ${
                    equipped ? 'deck-card-active' : owned ? '' : 'deck-card-muted'
                  }`}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className={`font-display text-[13px] font-semibold ${owned ? 'text-white' : 'text-white/60'}`}>
                      {item.name}
                    </span>
                    <span className={`text-[9px] uppercase tracking-[0.14em] ${RARITY_STYLE[item.rarity]}`}>
                      {item.rarity}
                    </span>
                  </div>
                  <div className='mt-1 flex-1 font-sans text-[11px] leading-snug text-white/50'>{item.blurb}</div>
                  <div className='mt-2.5'>
                    {equipped ? (
                      <div className='py-1 text-[9px] uppercase tracking-[0.18em] text-cyan-300'>
                        ✓ Equipped
                      </div>
                    ) : owned ? (
                      <DeckButton
                        data-action='equip'
                        disabled={working}
                        onClick={() => equip(sl, item.id)}
                        accent='cyan'
                        size='sm'
                        full
                        center
                      >
                        {working ? '…' : 'Equip'}
                      </DeckButton>
                    ) : buyable ? (
                      <DeckButton
                        data-action='buy'
                        disabled={working || !affordable}
                        onClick={() => buy(sl, item.id)}
                        accent='amber'
                        size='sm'
                        full
                        center
                        title={affordable ? undefined : 'Not enough credits'}
                      >
                        {working ? '…' : `Buy · ${item.source.type === 'credits' ? item.source.price : 0} ⛁`}
                      </DeckButton>
                    ) : (
                      <div className='py-1 text-[10px] uppercase tracking-[0.12em] text-white/35'>
                        🔒 {sourceLabel(item.source)}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </LockerShell>
    {caseSpin && (
      <CaseSpinner
        won={caseSpin.won}
        dupe={caseSpin.dupe}
        refund={caseSpin.refund}
        onClose={() => setCaseSpin(null)}
      />
    )}
    </>
  );
}

// A placeholder tile the shape of a locker item, shown while the profile
// (ownership + credits) is still loading.
function LockerItemSkeleton() {
  return (
    <div className='deck-card flex flex-col px-3 py-2.5'>
      <div className='flex items-center justify-between gap-2'>
        <Skeleton className='h-3.5 w-24' />
        <Skeleton className='h-2 w-8' />
      </div>
      <Skeleton className='mt-2 h-2.5 w-full' />
      <Skeleton className='mt-1 h-2.5 w-3/4' />
      <Skeleton className='mt-3 h-7 w-full' />
    </div>
  );
}

// The Locker's frame: the shared ModalShell, wide, with a STICKY tab row +
// credits readout under the title so the tabs never scroll away, over a
// scrolling body.
function LockerShell({
  tab,
  setTab,
  credits,
  loading,
  onClose,
  children,
}: {
  tab: LockerTab;
  setTab: (t: LockerTab) => void;
  credits: number | null;
  loading: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <ModalShell
      title='Locker'
      onClose={onClose}
      size='lg'
      scroll
      bodyClassName='gap-4'
      header={
        <div className='-mx-2 -mt-1 -mb-3 flex items-center justify-between gap-3'>
          <div role='tablist' aria-label='Locker categories' className='flex flex-wrap'>
            {LOCKER_TABS.map((t) => (
              <DeckTab key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
              </DeckTab>
            ))}
          </div>
          {loading ? (
            <Skeleton className='mr-2 h-3.5 w-14' />
          ) : (
            credits != null && (
              <span className='mr-2 shrink-0 font-mono text-[11px] font-semibold tabular-nums text-amber-300'>
                {credits} ⛁
              </span>
            )
          )}
        </div>
      }
    >
      {children}
    </ModalShell>
  );
}

// Krunker-style unboxing roulette: a horizontal reel of hat cards that decelerates
// onto the server-decided winner under a center ticker, then reveals it.
function CaseSpinner({
  won,
  dupe,
  refund,
  onClose,
}: {
  won: string;
  dupe: boolean;
  refund: number;
  onClose: () => void;
}) {
  const LAND = 48; // index the winner is placed at in the reel
  const LEN = 56;
  const CARD = 104;
  const GAP = 8;
  const STRIDE = CARD + GAP;
  const reelRef = useRef<HatCosmetic[] | null>(null);
  if (!reelRef.current) {
    const pool = caseHats();
    const arr: HatCosmetic[] = [];
    for (let i = 0; i < LEN; i++) {
      arr.push(i === LAND ? hatById(won) : pool[Math.floor(Math.random() * pool.length)]);
    }
    reelRef.current = arr;
  }
  const reel = reelRef.current;
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const vpRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vp = vpRef.current?.clientWidth ?? 480;
    const jitter = (Math.random() - 0.5) * (CARD * 0.55); // land slightly off-center for suspense
    const target = LAND * STRIDE + CARD / 2 - vp / 2 + jitter;
    const a = requestAnimationFrame(() => requestAnimationFrame(() => setOffset(-target)));
    const t = window.setTimeout(() => setRevealed(true), 4500);
    return () => {
      cancelAnimationFrame(a);
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wonHat = hatById(won);
  // Not dismissable until the reel has landed — the reveal is the payoff.
  return (
    <ModalShell
      label='Hat case'
      tone='fuchsia'
      fixed
      z='z-50'
      size='lg'
      backdrop='heavy'
      onClose={revealed ? onClose : undefined}
    >
      {({ close }) => (
        <>
          <div className='-mb-2 text-center text-[11px] uppercase tracking-[0.3em] text-fuchsia-200/80' aria-live='polite'>
            {revealed ? (dupe ? 'Duplicate' : 'Unboxed!') : 'Opening case…'}
          </div>
          <div ref={vpRef} className='relative h-28 overflow-hidden border border-white/10 bg-black/40'>
            <div className='pointer-events-none absolute left-1/2 top-0 z-10 h-full w-0.5 -translate-x-1/2 bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.9)]' />
            <div
              className='absolute top-1/2 flex -translate-y-1/2 gap-2'
              style={{
                transform: `translateX(${offset}px)`,
                transition: offset !== 0 ? 'transform 4.4s cubic-bezier(0.12,0.85,0.18,1)' : 'none',
              }}
            >
              {reel.map((h, i) => (
                <HatReelCard key={i} hat={h} width={CARD} />
              ))}
            </div>
          </div>
          {revealed && (
            <div className='flex flex-col items-center gap-1 text-center'>
              <div className={`font-display text-xl font-bold uppercase tracking-[0.08em] ${RARITY_STYLE[wonHat.rarity]}`}>
                {wonHat.name}
              </div>
              <div className='text-[10px] uppercase tracking-[0.2em] text-white/45'>
                {wonHat.rarity} hat
              </div>
              {dupe && (
                <div className='mt-1 text-sm font-semibold text-amber-300'>
                  Duplicate — refunded {refund} ⛁
                </div>
              )}
              <DeckButton onClick={close} solid accent='emerald' center className='mt-3' data-autofocus>
                Nice
              </DeckButton>
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}

function HatReelCard({ hat, width }: { hat: HatCosmetic; width: number }) {
  const ring =
    hat.rarity === 'epic'
      ? 'border-fuchsia-400/60'
      : hat.rarity === 'rare'
        ? 'border-sky-400/50'
        : 'border-white/15';
  return (
    <div
      style={{ width }}
      className={`flex h-24 shrink-0 flex-col items-center justify-center gap-1 border-2 bg-white/[0.04] px-2 ${ring}`}
    >
      <span className='text-2xl'>🎩</span>
      <span className='line-clamp-2 text-center text-[10px] leading-tight text-white/80'>
        {hat.name}
      </span>
      <span className={`text-[8px] uppercase tracking-[0.12em] ${RARITY_STYLE[hat.rarity]}`}>
        {hat.rarity}
      </span>
    </div>
  );
}
