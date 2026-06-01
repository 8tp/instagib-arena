import { useEffect, useRef, useState } from 'react';
import { CharacterPreview, type PreviewCosmetics } from './game/character-preview';
import { EMOTES, HATS, RAIL_COLORS, RAILGUN_FINISHES, KILL_EFFECTS } from './game/cosmetics';

// Dev-only harness for the Locker character preview. /lockerlab. Keys: E cycles
// emote, H cycles hat, R rail colour, K kill effect, V cycles the view
// (character / emote / weapon). Not linked anywhere.
const VIEWS = ['character', 'emote', 'weapon'] as const;
export default function LockerLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<CharacterPreview | null>(null);
  const idx = useRef({ e: 0, h: 1, r: 0, k: 0, v: 0, g: 0 });
  const [label, setLabel] = useState('');

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const cos = (): PreviewCosmetics => ({
      hatId: HATS[idx.current.h % HATS.length].id,
      unusualId: 'unusual.none',
      emoteId: EMOTES[idx.current.e % EMOTES.length].id,
      railColor: RAIL_COLORS[idx.current.r % RAIL_COLORS.length].id,
      railgunFinish: RAILGUN_FINISHES[idx.current.g % RAILGUN_FINISHES.length].id,
      killEffect: KILL_EFFECTS[idx.current.k % KILL_EFFECTS.length].id,
      view: VIEWS[idx.current.v % VIEWS.length],
    });
    let preview = new CharacterPreview(canvas, cos());
    previewRef.current = preview;
    preview.start();
    const setLab = () =>
      setLabel(
        `view:${VIEWS[idx.current.v % VIEWS.length]}  emote:${EMOTES[idx.current.e % EMOTES.length].kind}  hat:${HATS[idx.current.h % HATS.length].name}  rail:${RAIL_COLORS[idx.current.r % RAIL_COLORS.length].name}  kill:${KILL_EFFECTS[idx.current.k % KILL_EFFECTS.length].name}`,
      );
    const refresh = () => {
      preview.setCosmetics(cos());
      setLab();
    };
    // The view is fixed per instance (matches the Locker, which remounts per
    // tab), so cycling the view rebuilds the preview.
    const remount = () => {
      preview.dispose();
      preview = new CharacterPreview(canvas, cos());
      previewRef.current = preview;
      preview.start();
      setLab();
    };
    setLab();
    const onKey = (ev: KeyboardEvent) => {
      const k = ev.key.toLowerCase();
      if (k === 'e') idx.current.e++;
      else if (k === 'h') idx.current.h++;
      else if (k === 'r') idx.current.r++;
      else if (k === 'k') idx.current.k++;
      else if (k === 'g') {
        idx.current.g++;
        remount(); // the weapon view builds the gun once → rebuild to reskin
        return;
      } else if (k === 'v') {
        idx.current.v++;
        remount();
        return;
      } else return;
      refresh();
    };
    window.addEventListener('keydown', onKey);
    const onResize = () => previewRef.current?.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      previewRef.current?.dispose();
    };
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 35%, #1a2230, #0a0d13)' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
      <div style={{ position: 'absolute', bottom: 12, left: 12, color: '#9fb0c8', fontFamily: 'monospace', fontSize: 12 }}>
        lockerlab · V view · E emote · H hat · R rail · K kill — {label}
      </div>
    </div>
  );
}
