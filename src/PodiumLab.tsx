import { useEffect, useRef } from 'react';
import { PodiumScene, type PodiumWinner } from './game/podium';
import { EMOTES } from './game/cosmetics';

// Dev-only verification harness for the end-of-match podium. Visit /podiumlab to
// see the 3-pedestal scene with assorted hats + every emote, without playing a
// full match (pointer-lock is blocked headless). Not linked anywhere in the UI.
// URL params (for screenshots): ?e1=emote.flex&e2=emote.salute&e3=emote.beckon
// &h1=hat.crown&h2=…&h3=… (emote/hat ids for places 1–3).
const MOCK: PodiumWinner[] = [
  { place: 1, name: 'Champion', score: 25, hatId: 'hat.hardhat', emoteId: 'emote.cheer' },
  { place: 2, name: 'Runner-Up', score: 21, hatId: 'hat.propeller', emoteId: 'emote.dance' },
  { place: 3, name: 'Bronze', score: 18, hatId: 'hat.tophat', emoteId: 'emote.wave' },
];

function winnersFromUrl(): PodiumWinner[] {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  if (!q) return MOCK;
  return MOCK.map((m) => ({
    ...m,
    emoteId: q.get(`e${m.place}`) ?? m.emoteId,
    hatId: q.get(`h${m.place}`) ?? m.hatId,
  }));
}

export default function PodiumLab() {
  const ref = useRef<HTMLCanvasElement>(null);
  const emoteRef = useRef(0);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const base = winnersFromUrl();
    const scene = new PodiumScene(canvas);
    void scene.setWinners(base);
    scene.start();
    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);
    // Press E to cycle the champion through every emote for visual review.
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'e') return;
      emoteRef.current = (emoteRef.current + 1) % EMOTES.length;
      const k = EMOTES[emoteRef.current].id;
      void scene.setWinners(base.map((m) => (m.place === 1 ? { ...m, emoteId: k } : m)));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      scene.dispose();
    };
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'radial-gradient(circle at 50% 30%, #1a2230, #0a0d13)' }}>
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
      <div style={{ position: 'absolute', bottom: 12, left: 12, color: '#7c8aa0', fontFamily: 'monospace', fontSize: 12 }}>
        podiumlab · press E to cycle champion emote · ?e1=&e2=&e3= emote ids, ?h1=… hat ids
      </div>
    </div>
  );
}
