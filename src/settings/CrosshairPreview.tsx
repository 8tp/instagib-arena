import { memo, useState } from 'react';
import { SegButton } from '../deck';
import { sfxProps } from '../deck-core';
import type { CrosshairConfig } from '../app-types';
import { CROSSHAIR_SHAPE_PRESETS, DEFAULT_CROSSHAIR } from './codec';

// Same SVG the in-match HUD draws (CrosshairGraphic in InstagibClient.tsx), so
// the preview is pixel-identical to what you get in a match.
export const CrosshairGlyph = memo(function CrosshairGlyph({ cfg }: { cfg: CrosshairConfig }) {
  const { style, color, size, thickness, gap, dotSize, outline } = cfg;
  const arms = style === 'cross' || style === 'cross-dot';
  const ring = style === 'circle';
  const ringR = gap + size;
  const dotR = style === 'dot' || style === 'cross-dot' ? Math.max(dotSize, thickness) : dotSize;
  const showDot = dotR > 0;
  const ext = Math.max(arms ? gap + size : 0, ring ? ringR + thickness : 0, showDot ? dotR : 0);
  const sw = outline ? cfg.outlineThickness : 0;
  const stroke = outline ? cfg.outlineColor : 'none';
  const pad = sw + thickness + 2;
  const half = ext + pad;
  const w = half * 2;
  const c = half;
  return (
    <svg width={w} height={w} viewBox={`0 0 ${w} ${w}`} aria-hidden>
      {arms && (
        <g fill={color} stroke={stroke} strokeWidth={sw}>
          <rect x={c - thickness / 2} y={c - gap - size} width={thickness} height={size} />
          <rect x={c - thickness / 2} y={c + gap} width={thickness} height={size} />
          <rect x={c - gap - size} y={c - thickness / 2} width={size} height={thickness} />
          <rect x={c + gap} y={c - thickness / 2} width={size} height={thickness} />
        </g>
      )}
      {ring && <circle cx={c} cy={c} r={ringR} fill='none' stroke={color} strokeWidth={thickness} />}
      {showDot && <circle cx={c} cy={c} r={dotR} fill={color} stroke={stroke} strokeWidth={sw} />}
    </svg>
  );
});

const ZOOMS = [1, 2, 4] as const;

// Live preview: a game-like arena backdrop (sky, walls, a target dummy, a
// floor grid) with the crosshair centered, plus light / mid / dark swatches to
// judge visibility across map tones. Zoom is preview-only.
export function CrosshairPreview({ cfg }: { cfg: CrosshairConfig }) {
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
  const glow = { filter: `drop-shadow(0 0 3px ${cfg.color}66)` };
  return (
    <div className='st-xh'>
      <div className='st-xh-scene' role='img' aria-label='Crosshair preview over a sample arena'>
        <div className='st-xh-sky' />
        <div className='st-xh-wall st-xh-wall-a' />
        <div className='st-xh-wall st-xh-wall-b' />
        <div className='st-xh-floor' />
        <div className='st-xh-dummy' aria-hidden>
          <span className='st-xh-head' />
          <span className='st-xh-torso' />
        </div>
        <div className='st-xh-reticle' style={{ transform: `scale(${zoom})`, ...glow }}>
          <CrosshairGlyph cfg={cfg} />
        </div>
        <div className='st-xh-zoom' role='group' aria-label='Preview zoom'>
          {ZOOMS.map((z) => (
            <SegButton key={z} active={zoom === z} onClick={() => setZoom(z)}>
              {z}×
            </SegButton>
          ))}
        </div>
      </div>
      <div className='st-xh-swatches' aria-label='Visibility on light, mid and dark backdrops'>
        {['#dce3ec', '#6b7480', '#10141b'].map((bg) => (
          <div key={bg} className='st-xh-swatch' style={{ backgroundColor: bg }}>
            <div style={{ transform: `scale(${zoom === 1 ? 1 : Math.min(zoom, 2)})`, ...glow }}>
              <CrosshairGlyph cfg={cfg} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SAME = (a: Partial<CrosshairConfig>, b: CrosshairConfig) =>
  (Object.keys(a) as (keyof CrosshairConfig)[]).every((k) => a[k] === b[k]);

// Quick-apply shape presets (each sets the full shape config; color/outline are
// kept from the current crosshair).
export function CrosshairShapePresets({
  cfg,
  onPick,
}: {
  cfg: CrosshairConfig;
  onPick: (p: Partial<CrosshairConfig>) => void;
}) {
  return (
    <div className='st-presets' role='group' aria-label='Shape presets'>
      {CROSSHAIR_SHAPE_PRESETS.map((p) => (
        <button
          key={p.id}
          type='button'
          onClick={() => onPick(p.cfg)}
          aria-pressed={SAME(p.cfg, cfg)}
          {...sfxProps('uiClick')}
          className='st-preset'
        >
          <span className='st-preset-glyph'>
            <CrosshairGlyph cfg={{ ...DEFAULT_CROSSHAIR, ...p.cfg, color: '#d6f4ff', outline: false }} />
          </span>
          <span className='st-preset-name'>{p.label}</span>
        </button>
      ))}
    </div>
  );
}

// Quick high-visibility color presets for the crosshair (#26d).
const CROSSHAIR_COLOR_PRESETS = ['#00ff88', '#ffffff', '#ff2bd6', '#ffe100', '#00e5ff', '#ff3b30'];

export function CrosshairColorPresets({ value, onPick }: { value: string; onPick: (c: string) => void }) {
  return (
    <div className='st-swatch-row' role='group' aria-label='Color presets'>
      {CROSSHAIR_COLOR_PRESETS.map((c) => (
        <button
          key={c}
          type='button'
          aria-label={`Use ${c}`}
          aria-pressed={value.toLowerCase() === c}
          onClick={() => onPick(c)}
          {...sfxProps('uiClick')}
          className='st-swatch'
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}
