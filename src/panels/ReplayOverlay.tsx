import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Settings } from '../app-types';
import { useModalStack } from '../deck-core';
import { DeckButton, SegButton, UtilButton } from '../deck';
import { ReplayViewer, type ReplayViewerState } from '../game/replay-viewer';
import { decodeReplay, type ReplayData } from '../game/replay-codec';
import { fmtChallengeTime } from './shared';

// Full-screen rewatch of a weekly-challenge run (first-person, scrubbable).
const REPLAY_SPEEDS = [0.5, 1, 2] as const;

export function ReplayViewerOverlay({
  playerId,
  playerName,
  settings,
  onClose,
}: {
  playerId: string;
  playerName: string;
  settings: Settings;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<ReplayViewer | null>(null);
  const [state, setState] = useState<ReplayViewerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFs, setIsFs] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  // Snapshot the graphics settings once so the viewer matches the game's look
  // without re-creating on every settings change mid-watch.
  const gfxRef = useRef({
    fov: settings.fov,
    resolutionScale: settings.resolutionScale,
    lowSpec: settings.lowSpec,
    volume: settings.volume,
    sfxVolume: settings.sfxVolume,
    announcerVolume: settings.announcerVolume,
    announcerEnabled: settings.announcerEnabled,
    announcerPack: settings.announcerPack,
  });
  // onClose changes identity on every parent (Lobby) re-render — keep it in a ref
  // so the viewer effect can depend only on playerId. Otherwise the Lobby's
  // polling re-renders would tear down + recreate the viewer mid-watch, snapping
  // playback back to 0.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Sit on top of the modal stack so the Weekly dialog underneath ignores the
  // Escape that closes this viewer (instead of both closing at once).
  useModalStack();

  useEffect(() => {
    let cancelled = false;
    let viewer: ReplayViewer | null = null;
    (async () => {
      try {
        const res = await fetch(
          `/api/challenge/weekly/replay?player=${encodeURIComponent(playerId)}`,
          { credentials: 'same-origin' },
        );
        if (!res.ok) throw new Error('unavailable');
        const buf = await res.arrayBuffer();
        let data: ReplayData;
        try {
          data = decodeReplay(buf);
        } catch {
          throw new Error('corrupt');
        }
        if (cancelled || !canvasRef.current) return;
        viewer = new ReplayViewer(
          canvasRef.current,
          data,
          (s) => {
            if (!cancelled) setState(s);
          },
          gfxRef.current,
        );
        viewerRef.current = viewer;
        await viewer.start(); // starts paused on the first frame
      } catch {
        if (!cancelled) setError('This run could not be loaded.');
      }
    })();
    // Esc closes (or exits fullscreen first); Space toggles play.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.fullscreenElement) return; // browser handles fullscreen exit
        onCloseRef.current();
      } else if (e.code === 'Space') {
        e.preventDefault();
        viewerRef.current?.togglePlay();
      }
    };
    const onFsChange = () => setIsFs(!!document.fullscreenElement);
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      viewer?.dispose();
      viewerRef.current = null;
    };
  }, [playerId]);

  // Once the scene is loaded + the first frame is rendering (behind the black
  // cover), run a short 3-2-1 countdown, then auto-play. The cover masks the
  // initial load/first-frame warm-up so the rewatch never flashes a blank frame.
  const ready = state?.ready ?? false;
  const startedRef = useRef(false);
  useEffect(() => {
    if (!ready || error || startedRef.current) return;
    startedRef.current = true;
    let n = 3;
    setCountdown(n);
    const id = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(id);
        setCountdown(null);
        viewerRef.current?.play();
      } else {
        setCountdown(n);
      }
    }, 700);
    return () => clearInterval(id);
  }, [ready, error]);

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  }, []);

  const duration = state?.duration ?? 0;
  const t = state?.t ?? 0;
  const playing = state?.playing ?? false;
  // Cover the canvas (black) until the scene is loaded AND the intro countdown has
  // finished — masks the initial load + first-frame warm-up so it never flashes.
  const showCover = !!error || !ready || countdown !== null;

  // Portal to <body> so the overlay escapes the modal's clip-path / transform
  // (which otherwise traps a position:fixed child into a tiny clipped square).
  return createPortal(
    <div ref={rootRef} className='fixed inset-0 z-[200] flex flex-col bg-black font-mono'>
      <canvas ref={canvasRef} className='absolute inset-0 block h-full w-full' />

      {/* Loading / countdown cover */}
      {showCover && (
        <div
          className={`absolute inset-0 z-[5] flex flex-col items-center justify-center ${
            countdown !== null ? 'bg-black/55' : 'bg-black'
          }`}
        >
          {error ? (
            <div className='text-[13px] text-rose-300'>{error}</div>
          ) : countdown !== null ? (
            <>
              <div className='text-[10px] uppercase tracking-[0.3em] text-cyan-300/80'>Starting run</div>
              <div className='mt-1 font-display text-7xl font-bold tabular-nums text-white drop-shadow-[0_0_24px_rgba(34,211,238,0.5)]'>
                {countdown}
              </div>
            </>
          ) : (
            <div className='flex flex-col items-center gap-3'>
              <div className='h-7 w-7 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-300' />
              <div className='text-[12px] uppercase tracking-[0.2em] text-white/55'>Loading replay…</div>
            </div>
          )}
        </div>
      )}

      {/* Top bar */}
      <div className='relative z-10 flex items-center justify-between bg-gradient-to-b from-black/80 to-transparent px-5 py-3'>
        <div className='flex items-baseline gap-2'>
          <span className='text-[10px] uppercase tracking-[0.2em] text-cyan-300'>Replay</span>
          <span className='font-display text-sm font-semibold text-white/90'>{playerName}&apos;s run</span>
        </div>
        <div className='flex items-center gap-2'>
          <UtilButton onClick={toggleFullscreen}>{isFs ? '⤢ Windowed' : '⛶ Fullscreen'}</UtilButton>
          <UtilButton onClick={onClose} sound='uiBack'>
            Close ✕
          </UtilButton>
        </div>
      </div>

      <div className='flex-1' />

      {/* Bottom controls */}
      <div className='relative z-10 bg-gradient-to-t from-black/85 to-transparent px-5 pb-5 pt-8'>
        {error ? (
          <div className='text-center text-[13px] text-rose-300'>{error}</div>
        ) : !ready ? (
          <div className='text-center text-[11px] uppercase tracking-[0.2em] text-white/50'>Loading replay…</div>
        ) : (
          <div className='mx-auto flex max-w-3xl items-center gap-3'>
            <DeckButton
              onClick={() => viewerRef.current?.togglePlay()}
              solid
              accent='cyan'
              size='sm'
              center
              className='w-16'
              aria-label={playing ? 'Pause' : 'Play'}
              sound='uiClick'
            >
              {playing ? '❚❚' : '▶'}
            </DeckButton>
            <span className='w-12 shrink-0 text-right text-[11px] tabular-nums text-white/70'>
              {fmtChallengeTime(t * 1000)}
            </span>
            <input
              type='range'
              aria-label='Scrub'
              min={0}
              max={Math.max(0.1, duration)}
              step={0.05}
              value={Math.min(t, duration)}
              onChange={(ev) => viewerRef.current?.seek(parseFloat(ev.target.value))}
              className='deck-range h-1.5 flex-1'
            />
            <span className='w-12 shrink-0 text-[11px] tabular-nums text-white/40'>
              {fmtChallengeTime(duration * 1000)}
            </span>
            <div className='flex items-center gap-1' role='group' aria-label='Playback speed'>
              {REPLAY_SPEEDS.map((s) => (
                <SegButton
                  key={s}
                  active={state?.speed === s}
                  onClick={() => viewerRef.current?.setSpeed(s)}
                  className='px-2 py-1 font-mono text-[11px] normal-case tabular-nums tracking-normal'
                >
                  {s}×
                </SegButton>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
