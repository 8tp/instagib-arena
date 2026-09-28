import { useEffect, useRef, useState } from 'react';
import { GunLab as Lab } from './gun-lab';

// Dev-only harness for the railgun track (/gunlab, not linked anywhere).
// Deterministic frames of the first-person viewmodel in a real arena, a
// contact sheet of every finish, the rail beams in every colour and
// third-person guns on combatants. See gun-lab.ts for the URL params.
export default function GunLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<Array<{ x: number; y: number; text: string }>>([]);
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
            transform: 'translate(-50%, 0)',
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
        <div style={{ position: 'absolute', bottom: 10, left: 12, color: '#8fa0b8', fontFamily: 'monospace', fontSize: 12 }}>
          {caption}
        </div>
      )}
    </div>
  );
}
