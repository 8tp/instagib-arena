// "Preview": the item on YOUR combatant — the live 3D stage (CharacterPreview
// via LockerStage) wearing your current loadout with this item layered on top,
// drag to rotate. Wearables open full-body with a toggle to the slot's close
// framing; other slots open on the framing that shows them (weapon, finisher,
// spawn, emote). While open, the Locker's own stage is paused (one live
// preview at a time — see preview-bus.ts). Esc / backdrop / ✕ close.
import { useMemo, useState } from 'react';
import type { Settings } from '../app-types';
import { ModalShell, SegButton } from '../deck';
import { sfxProps } from '../deck-core';
import type { PreviewView } from '../game/character-preview';
import { nameColorById, titleById } from '../game/cosmetics';
import { DEFAULT_LOADOUT, itemDef } from '../game/items/catalog';
import type { ItemSlot, Look } from '../game/items/types';
import { LockerStage, type StageNameplate } from '../locker/LockerStage';
import { TIER_COLOR, isIridescent } from '../ui/rarity';
import { SLOT_LABEL } from './display';
import { TagPills, TierChip } from './parts';
import type { PreviewItem } from './preview-item';
import { SLOT_VIEW, previewCosmetics } from './slots';

export type PreviewSettings = Pick<Settings, 'looks' | 'playerName' | 'reducedEffects' | 'lowSpec'>;

// Slots whose items sit ON the body: full-body first, close-up on demand.
const WORN: readonly ItemSlot[] = ['hat', 'face', 'back'];
const CLOSE_LABEL: Partial<Record<ItemSlot, string>> = { hat: 'Head', face: 'Face', back: 'Back' };
const LOOPS: readonly PreviewView[] = ['finisher', 'spawn', 'emote', 'weapon'];

// What the stage is showing, in a line.
function stageNote(slot: ItemSlot): string {
  switch (slot) {
    case 'finisher':
      return 'Plays on a training bot, fired with your equipped rail beam.';
    case 'spawn':
      return 'Your character materialising with it, on a loop.';
    case 'finish':
      return 'On your railgun, firing your equipped rail beam.';
    case 'beam':
      return 'Fired from your equipped railgun.';
    case 'emote':
      return 'Performed by your character, in your current loadout.';
    case 'title':
    case 'nameColor':
      return 'Your nameplate as other players see it.';
    default:
      return 'On your character, with the rest of your current loadout.';
  }
}

export function ItemPreviewModal({ item, settings, onClose }: { item: PreviewItem; settings: PreviewSettings; onClose: () => void }) {
  const slot: ItemSlot = itemDef(item.def)?.slot ?? 'hat';
  const look: Look = item.look ?? { d: item.def };
  const closeView: PreviewView = slot === 'hat' && look.e ? 'crown' : SLOT_VIEW[slot];
  const worn = WORN.includes(slot);
  const [close, setClose] = useState(false);
  const [replayKey, setReplayKey] = useState(0);
  const view: PreviewView = worn && !close ? 'full' : closeView;
  const lookKeyStr = JSON.stringify(look);
  const cos = useMemo(
    () => previewCosmetics(settings.looks ?? {}, { slot, look }, view, settings),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settings.looks, lookKeyStr, slot, view, settings.playerName, settings.reducedEffects],
  );
  const c = TIER_COLOR[item.tier];
  const identity = slot === 'title' || slot === 'nameColor';
  const nameplate = useMemo<StageNameplate | null>(() => {
    if (!identity) return null;
    const colorId = slot === 'nameColor' ? item.def : (settings.looks?.nameColor?.d ?? DEFAULT_LOADOUT.nameColor);
    const t = titleById(slot === 'title' ? item.def : (settings.looks?.title?.d ?? DEFAULT_LOADOUT.title));
    return { name: settings.playerName || 'Player', color: nameColorById(colorId).color, title: t.dynamic === 'ranked' ? '#1 · Ranked' : t.text };
  }, [identity, slot, item.def, settings.looks, settings.playerName]);
  const loops = LOOPS.includes(view);

  return (
    <ModalShell
      title='Preview'
      fixed
      z='z-[80]'
      tone='plain'
      width='w-[min(1080px,96vw)]'
      scroll
      padded={false}
      onClose={onClose}
      closeSound='none'
      panelClassName='ec-pv-panel'
    >
      <div className='ec-pv' style={{ ['--rc' as string]: c.edge }}>
        <LockerStage
          modal
          className='ec-pv-stage'
          cos={cos}
          lowSpec={settings.lowSpec}
          offsetX={0}
          offsetY={view === 'weapon' ? -0.06 : 0}
          tint={c.edge}
          nameplate={nameplate}
          pulseKey={0}
          replayKey={replayKey}
          watermark={identity ? null : SLOT_LABEL[slot]}
        />
        <aside className='ec-pv-info'>
          <div className='flex flex-wrap items-center gap-2'>
            <TierChip tier={item.tier} />
            <span className='lk-chip text-white/60' style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)' }}>{SLOT_LABEL[slot]}</span>
          </div>
          <div className={`ec-pv-name ${isIridescent(item.tier) ? 'ec-iri-text' : ''}`} style={isIridescent(item.tier) ? undefined : { color: c.text }}>
            {item.name}
          </div>
          {item.tags && item.tags.length > 0 && <TagPills tags={item.tags} />}
          {item.blurb && <p className='lk-blurb'>{item.blurb}</p>}
          <p className='ec-pv-note'>{stageNote(slot)} Drag the stage (or use ← →) to turn it.</p>
          {(worn || loops) && (
            <div className='ec-pv-controls'>
              {worn && (
                <div className='flex gap-1' role='group' aria-label='Framing'>
                  <SegButton active={!close} onClick={() => setClose(false)} data-autofocus>
                    Full body
                  </SegButton>
                  <SegButton active={close} onClick={() => setClose(true)}>
                    {CLOSE_LABEL[slot] ?? 'Close-up'}
                  </SegButton>
                </div>
              )}
              {loops && (
                <button type='button' className='ec-btn' onClick={() => setReplayKey((k) => k + 1)} {...sfxProps('uiClick')}>
                  ↻ Replay
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </ModalShell>
  );
}
