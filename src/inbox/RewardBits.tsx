// What a reward looks like: credit / free-roll chips and item tiles. Used by the
// inbox (a gift's attachments, a claimed gift's items, the redeem reveal) and
// by the admin editors' previews, so staff see exactly what players will.
import type { CSSProperties } from 'react';
import type { ItemInstanceWire, RewardBundle } from '../game/items/types';
import { instBaseName, instFullName, instTags, instTier, instTileSub, thumbLook } from '../economy/display';
import { InstTile, QualityMarks } from '../economy/parts';
import { ItemTile } from '../ui/item-tile';
import { TicketGlyph } from '../menu/RewardTile';
import { TIER_COLOR } from '../ui/rarity';
import { specPreview } from './reward';

export function CreditChip({ amount, big = false }: { amount: number; big?: boolean }) {
  return (
    <span className={`ib-chip ib-chip-credits ${big ? 'ib-chip-big' : ''}`} aria-label={`${amount.toLocaleString()} credits`}>
      <span aria-hidden>⛁</span> {amount.toLocaleString()}
    </span>
  );
}

export function RollChip({ n, big = false }: { n: number; big?: boolean }) {
  return (
    <span className={`ib-chip ib-chip-rolls ${big ? 'ib-chip-big' : ''}`} aria-label={`${n} free roll${n === 1 ? '' : 's'}`}>
      <TicketGlyph size={big ? 18 : 15} /> {n}
      <small>{n === 1 ? 'free roll' : 'free rolls'}</small>
    </span>
  );
}

// A not-yet-minted item (a spec preview): an instance tile without a mint number.
export function SpecTile({ inst, size, fluid = false, label = false }: { inst: ItemInstanceWire; size?: number; fluid?: boolean; label?: boolean }) {
  const sub = instTileSub(inst);
  return (
    <ItemTile
      id={inst.def}
      size={size}
      fluid={fluid}
      tier={instTier(inst)}
      name={instBaseName(inst)}
      look={thumbLook(inst)}
      sub={sub || undefined}
      subColor={instTags(inst)[0]?.color}
      badge={<QualityMarks inst={inst} />}
      label={label}
      hint='none'
      rootProps={{ 'aria-label': instFullName(inst) }}
    />
  );
}

// A bundle's contents. `granted` (a claimed gift / redeemed code) replaces the
// item previews with the minted instances (real mint numbers). `stagger` adds
// the pop-in delay per element (CSS; the parent decides whether it animates).
export function RewardView({
  bundle,
  granted,
  tile = 92,
  big = false,
  names = true,
  className = '',
}: {
  bundle: RewardBundle;
  granted?: readonly ItemInstanceWire[];
  tile?: number;
  big?: boolean;
  names?: boolean;
  className?: string;
}) {
  const minted = !!granted && granted.length > 0;
  const items: ItemInstanceWire[] = minted ? [...granted] : (bundle.items ?? []).map((s, i) => specPreview(s, i));
  let k = 0;
  const pop = (): CSSProperties => ({ ['--i' as string]: k++ });
  return (
    <div className={`ib-reward ${className}`}>
      {(!!bundle.credits || !!bundle.rolls) && (
        <div className='ib-reward-chips'>
          {!!bundle.credits && (
            <span className='ib-pop' style={pop()}>
              <CreditChip amount={bundle.credits} big={big} />
            </span>
          )}
          {!!bundle.rolls && (
            <span className='ib-pop' style={pop()}>
              <RollChip n={bundle.rolls} big={big} />
            </span>
          )}
        </div>
      )}
      {items.length > 0 && (
        <ul className='ib-reward-items' style={{ ['--tile' as string]: `${tile}px` }}>
          {items.map((it) => (
            <li key={it.uid} className='ib-pop ib-reward-item' style={{ ...pop(), ['--tc' as string]: TIER_COLOR[instTier(it)].edge }}>
              {minted ? <InstTile inst={it} size={tile} fluid={false} label={false} /> : <SpecTile inst={it} size={tile} />}
              {names && (
                <span className='ib-reward-name' style={{ color: TIER_COLOR[instTier(it)].text }}>
                  {instFullName(it)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
