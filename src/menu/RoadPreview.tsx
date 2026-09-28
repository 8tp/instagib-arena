import { useEffect, useMemo, useRef, useState } from 'react';
import type { CharacterPreview, PreviewCosmetics, PreviewView } from '../game/character-preview';
import { cosmeticById, isKillEffectStyle, type KillEffectStyle } from '../game/cosmetics';
import type { RoadReward } from '../game/progression';
import { ItemTile } from '../ui/item-tile';
import { KeyGlyph } from './RewardTile';
import './menu.css';

// The Career Road's big preview: the selected reward in 3D, filling the left
// column — a finish or rail beam on the gun, a hat or unusual on YOUR
// character, a finisher as its loop, an emote played, a spawn effect
// materialising. Credits and keys get a big emblem; name colours, titles,
// cards and announcer packs (no 3D subject) a large tile.
//
// Uses the Locker's CharacterPreview (read-only): ONE WebGL context while a
// 3D reward is shown, switched with setCosmetics (the camera eases between
// framings), disposed when the road closes or a non-3D reward is selected.

export type PreviewLoadout = {
  seed: string;
  hat: string;
  unusual: string;
  railgunFinish: string;
  railColor: string;
  killEffect: KillEffectStyle;
  emote: string;
  spawnEffect: string;
};

// The try-on for a reward: your loadout with the reward swapped in, framed
// for its slot. null = no 3D subject.
function tryOn(reward: RoadReward, l: PreviewLoadout, reduced: boolean): PreviewCosmetics | null {
  if (reward.type !== 'cosmetic') return null;
  const c = cosmeticById(reward.id);
  if (!c) return null;
  const base: PreviewCosmetics = {
    hatId: l.hat,
    unusualId: l.unusual,
    emoteId: l.emote,
    railColor: l.railColor,
    railgunFinish: l.railgunFinish,
    killEffect: l.killEffect,
    spawnEffect: l.spawnEffect,
    skinSeed: l.seed,
    reducedEffects: reduced,
    view: 'full' as PreviewView,
  };
  switch (c.slot) {
    case 'hat':
      return { ...base, hatId: c.id, view: 'head' };
    case 'unusual':
      return { ...base, unusualId: c.id, view: 'crown' };
    case 'railgunFinish':
      return { ...base, railgunFinish: c.id, view: 'weapon' };
    case 'railColor':
      return { ...base, railColor: c.id, view: 'weapon' };
    case 'killEffect':
      return isKillEffectStyle(c.id) ? { ...base, killEffect: c.id, view: 'finisher' } : null;
    case 'spawnEffect':
      return { ...base, spawnEffect: c.id, view: 'spawn' };
    case 'emote':
      return { ...base, emoteId: c.id, view: 'emote' };
    default:
      return null;
  }
}

function Stage3D({ cos, lowSpec, active }: { cos: PreviewCosmetics; lowSpec: boolean; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const latest = useRef(cos);
  const activeRef = useRef(active);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    let pending = 0;
    import('../game/character-preview')
      .then((m) => {
        const canvas = canvasRef.current;
        if (disposed || !canvas) return;
        let p: CharacterPreview;
        try {
          p = new m.CharacterPreview(canvas, latest.current, { lowSpec });
        } catch {
          return; // no WebGL: the column stays a quiet backdrop
        }
        previewRef.current = p;
        p.enableOrbit(canvas);
        if (activeRef.current) p.start();
        ro = new ResizeObserver(() => {
          cancelAnimationFrame(pending);
          pending = requestAnimationFrame(() => p.resize());
        });
        ro.observe(canvas);
        setReady(true);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      cancelAnimationFrame(pending);
      ro?.disconnect();
      previewRef.current?.dispose();
      previewRef.current = null;
    };
  }, [lowSpec]);

  useEffect(() => {
    latest.current = cos;
    previewRef.current?.setCosmetics(cos);
  }, [cos]);

  // Hidden behind a 2D reward: pause, but keep the context (no remount churn).
  useEffect(() => {
    activeRef.current = active;
    if (active) previewRef.current?.start();
    else previewRef.current?.stop();
  }, [active]);

  return (
    <canvas
      ref={canvasRef}
      className={`road-stage-canvas ${ready ? 'road-stage-ready' : ''}`}
      style={active ? undefined : { display: 'none' }}
      aria-hidden='true'
    />
  );
}

export function RoadPreview({
  reward,
  loadout,
  locked,
  lowSpec,
  reduced,
}: {
  reward: RoadReward;
  loadout: PreviewLoadout;
  locked: boolean;
  lowSpec: boolean;
  reduced: boolean;
}) {
  const cos = useMemo(() => tryOn(reward, loadout, reduced), [reward, loadout, reduced]);
  // Once a 3D reward has been shown, the stage stays mounted (hidden + paused
  // for 2D rewards) so browsing the road never churns WebGL contexts.
  const [lastCos, setLastCos] = useState<PreviewCosmetics | null>(cos);
  if (cos && cos !== lastCos) setLastCos(cos);
  const stage = lastCos ? <Stage3D cos={cos ?? lastCos} lowSpec={lowSpec} active={!!cos} /> : null;
  if (cos) return stage;
  return (
    <>
      {stage}
      <Flat reward={reward} locked={locked} />
    </>
  );
}

function Flat({ reward, locked }: { reward: RoadReward; locked: boolean }) {
  if (reward.type === 'credits') {
    return (
      <div className='road-emblem road-emblem-credits' data-locked={locked ? '1' : '0'}>
        <span aria-hidden='true' className='road-emblem-glyph'>
          ⛁
        </span>
        <span className='road-emblem-amount'>{reward.amount.toLocaleString()}</span>
      </div>
    );
  }
  if (reward.type === 'case') {
    return (
      <div className='road-emblem road-emblem-key' data-locked={locked ? '1' : '0'}>
        <KeyGlyph size={220} />
      </div>
    );
  }
  return (
    <div className='road-emblem'>
      <div className='w-[min(78%,420px)]'>
        <ItemTile id={reward.id} fluid label={false} locked={locked} />
      </div>
    </div>
  );
}
