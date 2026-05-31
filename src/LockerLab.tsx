import { useEffect, useRef, useState } from 'react';
import { CharacterPreview, type PreviewCosmetics } from './game/character-preview';
import { EMOTES, HATS, RAIL_COLORS, KILL_EFFECTS } from './game/cosmetics';

// Dev-only harness for the Locker character preview. /lockerlab. Keys: E cycles
// emote, H cycles hat, R rail colour, K kill effect. Not linked anywhere.
export default function LockerLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const idx = useRef({ e: 0, h: 1, r: 0, k: 0 });
  const [label, setLabel] = useState('');

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const cos = (): PreviewCosmetics => ({
      hatId: HATS[idx.current.h % HATS.length].id,
      unusualId: 'unusual.none',
      emoteId: EMOTES[idx.current.e % EMOTES.length].id,
      railColor: RAIL_COLORS[idx.current.r % RAIL_COLORS.length].id,
      killEffect: KILL_EFFECTS[idx.current.k % KILL_EFFECTS.length].id,
    });
    const preview = new CharacterPreview(canvas, cos());
    previewRef.current = preview;
    preview.start();
    const refresh = () => {
      preview.setCosmetics(cos());
      setLabel(
        `emote:${EMOTES[idx.current.e % EMOTES.length].kind}  hat:${HATS[idx.current.h % HATS.length].name}  rail:${RAIL_COLORS[idx.current.r % RAIL_COLORS.length].name}  kill:${KILL_EFFECTS[idx.current.k % KILL_EFFECTS.length].name}`,
      );
    };
    refresh();
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (k === 'e') idx.current.e++;
      else if (k === 'h') idx.current.h++;
      else if (k === 'r') idx.current.r++;
      else if (k === 'k') idx.current.k++;
      else return;
      refresh();
    };
    window.addEventListener('keydown', onKey);
    const onResize = () => preview.resize();
    window.addEventListener('resize', onResize);
    (window as unknown as { __lockerlab?: unknown }).__lockerlab = { preview, idx, refresh };
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      preview.dispose();
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 35%, #1a2230, #0a0d13)' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
      <div style={{ position: 'absolute', bottom: 12, left: 12, color: '#9fb0c8', fontFamily: 'monospace', fontSize: 12 }}>
        lockerlab · E emote · H hat · R rail · K kill — {label}
      </div>
    </div>
  );
}
