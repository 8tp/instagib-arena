import { useEffect, useRef, useState } from 'react';
import { FxLab as FxLabScene } from './fx-lab';

// Dev-only review page for finishers + unusuals (see fx-lab.ts for params).
// Not linked anywhere; mounted at /fxlab.
type Label = { x: number; y: number; w: number; h: number; label: string };

export default function FxLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [labels, setLabels] = useState<Label[]>([]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const lab = new FxLabScene(canvas, new URLSearchParams(window.location.search));
    lab.onLabels = setLabels;
    lab.resize();
    lab.start();
    const onResize = () => lab.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      lab.dispose();
    };
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#07090d' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
      {labels.map((l, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: l.x,
            top: l.y,
            width: l.w,
            height: l.h,
            boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)',
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              position: 'absolute',
              left: 6,
              bottom: 4,
              font: '600 11px ui-monospace, Menlo, monospace',
              color: 'rgba(220,230,245,0.8)',
              textShadow: '0 1px 2px #000',
            }}
          >
            {l.label}
          </span>
        </div>
      ))}
    </div>
  );
}
