// Small shared pieces of the economy screens: instance tiles, tier chips,
// quality marks and attribute pills, the balance readout, a price sparkline.
import { memo, type ReactNode } from 'react';
import { uiHover } from '../deck-core';
import { itemDef, type ItemDef } from '../game/items/catalog';
import { TIER_META, type ItemInstanceWire, type ItemSlot, type Tier } from '../game/items/types';
import { TicketGlyph } from '../menu/RewardTile';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, TIER_LABEL, isIridescent } from '../ui/rarity';
import type { TradeGate } from './api';
import { fmtCredits, gateRows, instBaseName, instFullName, instTags, instTier, instTileSub, qualityTone, thumbLook, type Tag } from './display';

// One thing that can sit on a tile: an owned instance, a virtual default, or a
// level-unlocked entitlement (cards) — owned or still locked.
export type Entry = {
  key: string; // uid, or 'def:<id>'
  slot: ItemSlot;
  def: ItemDef;
  inst?: ItemInstanceWire;
  locked?: boolean;
  lockNote?: string; // "Lv 35"
};

export function TierChip({ tier, className = '' }: { tier: Tier; className?: string }) {
  const c = TIER_COLOR[tier];
  return (
    <span
      className={`lk-chip ${isIridescent(tier) ? 'ec-iri-chip' : ''} ${className}`}
      style={isIridescent(tier) ? undefined : { background: c.edge, color: tier === 'common' || tier === 'legendary' || tier === 'uncommon' ? '#0a0b0e' : '#fff' }}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}

const MARK: Record<string, string> = { unusual: '✦', strange: '◎', killstreak: '▲', professional: '▲▲', festive: '❄', founder: '★', admin: '◆' };

// Compact glyph chips on a tile corner: ✦ unusual · ◎ strange · ▲ killstreak …
export function QualityMarks({ inst }: { inst: ItemInstanceWire }) {
  const q = inst.quality.filter((x) => x !== 'killstreak' || !inst.quality.includes('professional'));
  if (!q.length) return null;
  return (
    <>
      {q.map((x) => (
        <span
          key={x}
          title={x}
          className='px-[3px] py-[1px] font-display text-[11px] font-bold leading-none'
          style={{ background: 'rgba(0,0,0,0.66)', color: qualityTone(x), boxShadow: `inset 0 0 0 1px ${qualityTone(x)}77` }}
        >
          {MARK[x]}
        </span>
      ))}
    </>
  );
}

export function TagPills({ tags }: { tags: Tag[] }) {
  if (!tags.length) return null;
  return (
    <div className='flex flex-wrap gap-1.5'>
      {tags.map((t, i) => (
        <span
          key={i}
          className='inline-flex items-center px-2 py-[3px] font-sans text-[12px] font-semibold leading-tight'
          style={{ color: t.color, background: `${t.color}1f`, boxShadow: `inset 0 0 0 1px ${t.color}55` }}
        >
          {t.text}
        </span>
      ))}
    </div>
  );
}

// An instance as a tile (memoized; pass stable callbacks).
export const InstTile = memo(function InstTile({
  inst,
  size,
  fluid = true,
  selected,
  equipped,
  isNew,
  dot,
  tabbable,
  price,
  label = true,
  onPick,
  onHover,
  spin = false,
  rootProps,
}: {
  inst: ItemInstanceWire;
  spin?: boolean; // hover / keyboard focus plays the item's turntable
  label?: boolean;
  size?: number;
  fluid?: boolean;
  selected?: boolean;
  equipped?: boolean;
  isNew?: boolean;
  dot?: boolean;
  tabbable?: boolean;
  price?: ReactNode;
  onPick?: (inst: ItemInstanceWire) => void;
  onHover?: (inst: ItemInstanceWire) => void;
  rootProps?: Record<string, unknown>;
}) {
  const sub = instTileSub(inst);
  const tags = instTags(inst);
  return (
    <ItemTile
      id={inst.def}
      size={size}
      fluid={fluid}
      tier={instTier(inst)}
      name={instBaseName(inst)}
      look={thumbLook(inst)}
      sub={price ? undefined : sub || undefined}
      subColor={tags[0]?.color}
      mint={inst.mint}
      badge={<QualityMarks inst={inst} />}
      selected={selected}
      equipped={equipped}
      isNew={isNew}
      dot={dot}
      label={label}
      hint={price ?? 'none'}
      turntable={spin ? 'hover' : false}
      tabIndex={tabbable === undefined ? undefined : tabbable ? 0 : -1}
      onClick={onPick ? () => onPick(inst) : undefined}
      onPointerEnter={onHover ? (e) => { uiHover(e); onHover(inst); } : undefined}
      onFocus={onHover ? () => onHover(inst) : undefined}
      rootProps={{
        'data-tile': '',
        'data-uid': inst.uid,
        'data-def': inst.def,
        'aria-label': `${instFullName(inst)}, ${TIER_META[instTier(inst)].label}, mint ${inst.mint}${equipped ? ', equipped' : ''}`,
        ...rootProps,
      }}
    />
  );
});

// A virtual default / entitlement tile.
export const DefTile = memo(function DefTile({
  entry,
  selected,
  equipped,
  tabbable,
  onPick,
  onHover,
  spin = false,
}: {
  entry: Entry;
  selected?: boolean;
  equipped?: boolean;
  tabbable?: boolean;
  onPick: (e: Entry) => void;
  onHover: (e: Entry) => void;
  spin?: boolean;
}) {
  return (
    <ItemTile
      id={entry.def.id}
      fluid
      tier={entry.def.tier}
      turntable={spin && !entry.def.default ? 'hover' : false}
      selected={selected}
      equipped={equipped}
      locked={entry.locked}
      hint={entry.locked && entry.lockNote ? <span className='font-display text-[12px] font-bold text-cyan-200'>{entry.lockNote}</span> : 'none'}
      sub={entry.def.default ? 'Default' : undefined}
      tabIndex={tabbable ? 0 : -1}
      onClick={() => onPick(entry)}
      onPointerEnter={(e) => {
        uiHover(e);
        onHover(entry);
      }}
      onFocus={() => onHover(entry)}
      rootProps={{ 'data-tile': '', 'data-def': entry.def.id, 'aria-label': `${entry.def.name}${entry.def.default ? ', default' : ''}${entry.locked ? `, locked ${entry.lockNote ?? ''}` : ''}${equipped ? ', equipped' : ''}` }}
    />
  );
});

// Tile for a def id alone (case contents, road rewards).
export function DefIdTile({ id, size = 44 }: { id: string; size?: number }) {
  const d = itemDef(id);
  return <ItemTile id={id} size={size} label={false} tier={d?.tier} />;
}

export function Balance({ credits, freeRolls, compact = false }: { credits: number | null; freeRolls?: number | null; compact?: boolean }) {
  if (credits == null) return null;
  return (
    <div className='ec-balance' aria-label={`${credits} credits${freeRolls ? `, ${freeRolls} free rolls` : ''}`}>
      <b title='Credits'>{fmtCredits(credits)}</b>
      {freeRolls != null && (
        <span className='ec-rolls' title={`${freeRolls} free roll${freeRolls === 1 ? '' : 's'} — open any case without credits`}>
          <TicketGlyph /> {freeRolls}
          {!compact && <small>free rolls</small>}
        </span>
      )}
    </div>
  );
}

// ── Price sparkline (inline SVG, one series) ───────────────────────────────
export function Sparkline({
  points,
  width = 280,
  height = 64,
  color = '#67e8f9',
  label,
}: {
  points: { ts: number; price: number }[];
  width?: number;
  height?: number;
  color?: string;
  label: string;
}) {
  if (points.length < 2) return <div className='font-sans text-[13px] text-white/45'>Not enough sales yet.</div>;
  const pad = 4;
  const min = Math.min(...points.map((p) => p.price));
  const max = Math.max(...points.map((p) => p.price));
  const span = Math.max(1, max - min);
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)} ${height} L${x(0).toFixed(1)} ${height} Z`;
  const last = points[points.length - 1];
  return (
    <figure className='m-0'>
      <svg viewBox={`0 0 ${width} ${height}`} width='100%' height={height} role='img' aria-label={label} preserveAspectRatio='none' className='block overflow-visible'>
        <path d={area} fill={color} opacity='0.12' />
        <path d={line} fill='none' stroke={color} strokeWidth='1.8' strokeLinejoin='round' strokeLinecap='round' vectorEffect='non-scaling-stroke' />
        <circle cx={x(points.length - 1)} cy={y(last.price)} r='3' fill={color} />
      </svg>
      <figcaption className='mt-1 flex justify-between font-mono text-[12px] tabular-nums text-white/50'>
        <span>low {fmtCredits(min)}</span>
        <span>last {fmtCredits(last.price)}</span>
        <span>high {fmtCredits(max)}</span>
      </figcaption>
    </figure>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className='lk-empty'>{children}</div>;
}

// "Trading and the market are locked until…" — the three gates as a checklist.
export function GateBanner({ gate }: { gate: TradeGate | null }) {
  if (!gate || gate.ok) return null;
  const rows = gateRows(gate);
  return (
    <div className='ec-gatebanner' role='status'>
      <b>Trading and the market are locked</b>
      <span>Both need:</span>
      <ul>
        {rows.map((g) => (
          <li key={g.label} className={g.ok === true ? 'is-ok' : g.ok === false ? 'is-no' : 'is-unk'}>
            <span aria-hidden>{g.ok === true ? '✓' : g.ok === false ? '✕' : '·'}</span> {g.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
