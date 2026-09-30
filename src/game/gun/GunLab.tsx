import { useEffect, useRef, useState } from 'react';
import { GunLab as Lab } from './gun-lab';
import { CharacterPreview } from '../character-preview';

// Dev-only harness for the railgun track (/gunlab, not linked anywhere).
// Deterministic frames of the first-person viewmodel in a real arena, a
// contact sheet of every finish, the rail beams in every colour and
// third-person guns on combatants. See gun-lab.ts for the URL params.
// ?view=locker&finish=gun.stock&kills=87: the Locker/item-preview weapon stage
// (CharacterPreview) with a Tracked counter.
export default function GunLab() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'locker') return <LockerStageLab params={params} />;
  return <GunLabView />;
}

function LockerStageLab({ params }: { params: URLSearchParams }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const k = params.get('kills');
    const p = new CharacterPreview(canvas, {
      hatId: 'hat.none',
      unusualId: 'unusual.none',
      emoteId: 'emote.cheer',
      railColor: 'rail.cyan',
      railgunFinish: params.get('finish') ?? 'gun.stock',
      killEffect: 'pulse',
      view: 'weapon',
      trackedKills: k === null ? null : Number(k),
    });
    p.start();
    return () => p.dispose();
  }, [params]);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0d13' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

function GunLabView() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<Array<{ x: number; y: number; text: string; anchor?: 'below' | 'left' }>>([]);
  const [caption, setCaption] = useState('');
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const lab = new Lab(canvas, new URLSearchParams(window.location.search), (l, c) => {
      setLabels(l);
      setCaption(c);
    });
    (window as unknown as { __gunlab?: Lab }).__gunlab = lab;
    lab.start();
    const onResize = () => lab.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      lab.dispose();
    };
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0a0d13' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
      {labels.map((l, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${l.x * 100}%`,
            top: `${l.y * 100}%`,
            transform: l.anchor === 'left' ? 'translate(calc(-100% - 10px), -50%)' : 'translate(-50%, 0)',
            color: '#c9d4e4',
            fontFamily: 'monospace',
            fontSize: 13,
            textShadow: '0 1px 2px #000',
            whiteSpace: 'nowrap',
          }}
        >
          {l.text}
        </div>
      ))}
      {caption && (
        <div style={{ position: 'absolute', top: 8, right: 12, color: '#8fa0b8', fontFamily: 'monospace', fontSize: 12 }}>
          {caption}
        </div>
      )}
    </div>
  );
}
