// Hover card for a case-pool tile: a bigger look at the item — its turntable
// (worn on a combatant for hats / face / back / dyes; the clip or FX loop for
// taunts) — with name, tier, slot, blurb and a "Preview on you" button.
// Portalled + fixed beside the anchor tile, flipped / clamped to the viewport.
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { sfxProps } from '../deck-core';
import { itemDef } from '../game/items/catalog';
import { ItemTile } from '../ui/item-tile';
import { TIER_COLOR, isIridescent } from '../ui/rarity';
import { SLOT_LABEL } from './display';
import { TierChip } from './parts';
import { canPreview } from './preview-item';

const GAP = 12;
const EDGE = 12;

export function ItemHoverCard({
  id,
  anchor,
  reduced,
  onPreview,
  onEnter,
  onLeave,
}: {
  id: string;
  anchor: DOMRect;
  reduced: boolean;
  onPreview: () => void;
  onEnter: () => void; // pointer moved onto the card (keep it open)
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: 'r' | 'l' } | null>(null);
  const def = itemDef(id);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side: 'r' | 'l' = 'r';
    let left = anchor.right + GAP;
    if (left + w > vw - EDGE) {
      side = 'l';
      left = anchor.left - GAP - w;
    }
    left = Math.max(EDGE, Math.min(vw - EDGE - w, left));
    const top = Math.max(EDGE, Math.min(vh - EDGE - h, anchor.top + anchor.height / 2 - h * 0.42));
    setPos({ left, top, side });
  }, [anchor, id]);

  if (!def || typeof document === 'undefined') return null;
  const c = TIER_COLOR[def.tier];
  const iri = isIridescent(def.tier);
  return createPortal(
    <div
      ref={ref}
      className={`ec-hovercard ${reduced ? 'is-reduced' : ''} ${pos ? `is-${pos.side}` : ''}`}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', '--rc': c.edge } as CSSProperties}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      data-hovercard={id}
    >
      <div className='ec-hovercard-art'>
        <ItemTile id={id} fluid label={false} season={false} tier={def.tier} turntable={reduced ? false : 'play'} />
      </div>
      <div className='ec-hovercard-body'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <TierChip tier={def.tier} />
          <span className='lk-chip text-white/60' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>{SLOT_LABEL[def.slot]}</span>
        </div>
        <div className={`ec-hovercard-name ${iri ? 'ec-iri-text' : ''}`} style={iri ? undefined : { color: c.text }}>
          {def.name}
        </div>
        {def.blurb && <p className='ec-hovercard-blurb'>{def.blurb}</p>}
        {canPreview(id) && (
          <button type='button' className='ec-btn ec-btn-primary w-full' data-action='hover-preview' onClick={onPreview} {...sfxProps('uiClick')}>
            Preview on you
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
