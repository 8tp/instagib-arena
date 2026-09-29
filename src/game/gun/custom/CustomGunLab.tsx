import { useEffect, useRef, useState } from 'react';
import { CustomGunLab as Lab } from './lab';

// Dev-only harness for the custom railgun models (/customgunlab, not linked
// anywhere): contact sheets of every model in first person (idle / fired /
// recharging / streak), a 3/4 turntable and third person. See lab.ts for the
// URL params; window.__cgl.stats has the tri / draw / coverage numbers.
export default function CustomGunLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState('');
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const lab = new Lab(canvas, new URLSearchParams(window.location.search));
    (window as unknown as { __cgl?: Lab }).__cgl = lab;
    lab.run();
    setCaption(lab.caption);
    document.body.dataset.cglReady = '1';
    return () => lab.dispose();
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#05070b', overflow: 'auto' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: 'auto' }} />
      {caption && (
        <div style={{ position: 'fixed', bottom: 6, right: 10, color: '#8fa0b8', fontFamily: 'monospace', fontSize: 12 }}>
          {caption}
        </div>
      )}
    </div>
  );
}
