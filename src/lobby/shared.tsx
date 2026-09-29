import type { ReactNode } from 'react';
import { useLevelshots } from '../ui/levelshot';
import { mapParts, mapShotStyle } from './helpers';
import './lobby.css';

/* ── Tiny inline icons (stroke = currentColor) ──────────────────────────── */

export function Icon({ d, size = 20, children }: { d?: string; size?: number; children?: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 24 24'
      fill='none'
      stroke='currentColor'
      strokeWidth={1.8}
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      focusable='false'
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

export const IconRadar = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx='12' cy='12' r='2' />
    <path d='M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5' />
  </Icon>
);
export const IconWifiOff = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d='M2 8.8a15 15 0 0 1 4.2-2.3M22 8.8a15 15 0 0 0-8.5-3.7M5 12.9a10 10 0 0 1 3.2-2M19 12.9a10 10 0 0 0-2.4-1.8M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20' />
  </Icon>
);
export const IconAlert = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d='M12 3 2 20h20L12 3ZM12 10v4M12 17h.01' />
  </Icon>
);
export const IconCheck = ({ size = 12 }: { size?: number }) => <Icon d='M5 12.5 10 17.5 19 7' size={size} />;
export const IconCopy = ({ size = 14 }: { size?: number }) => (
  <Icon size={size}>
    <rect x='9' y='9' width='11' height='11' />
    <path d='M5 15V4h11' />
  </Icon>
);
export const IconServer = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x='3' y='4' width='18' height='6' />
    <rect x='3' y='14' width='18' height='6' />
    <path d='M7 7h.01M7 17h.01' />
  </Icon>
);
export const IconChat = ({ size }: { size?: number }) => (
  <Icon size={size} d='M4 5h16v11H9l-5 4V5Z' />
);
export const IconUsers = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx='9' cy='8' r='3.2' />
    <path d='M3 20a6 6 0 0 1 12 0M16 5a3.2 3.2 0 0 1 0 6M18 14a6 6 0 0 1 3 6' />
  </Icon>
);
export const IconCrosshair = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx='12' cy='12' r='7' />
    <path d='M12 2v5M12 17v5M2 12h5M17 12h5' />
  </Icon>
);

export function MapCard({
  mapId,
  active,
  onPick,
  shot,
}: {
  mapId: string;
  active: boolean;
  onPick: () => void;
  shot?: string; // levelshot data URL; the gradient shows until it is ready
}) {
  const { name, tag } = mapParts(mapId);
  const url = shot ?? null;
  return (
    <button
      type='button'
      role='radio'
      aria-checked={active}
      aria-label={`${name}${tag ? ` (${tag})` : ''}`}
      onClick={onPick}
      className='lb-map'
    >
      <div className='lb-map-shot' style={mapShotStyle(mapId, url)}>
        <span className='lb-map-check'>
          <IconCheck />
        </span>
        <div className='lb-map-meta'>
          <span className='lb-map-name'>{name}</span>
          {tag && <span className='lb-map-tag'>{tag}</span>}
        </div>
      </div>
    </button>
  );
}

export function MapPicker({
  label,
  maps,
  value,
  onChange,
}: {
  label: string;
  maps: ReadonlyArray<{ id: string }>;
  value: string;
  onChange: (id: string) => void;
}) {
  // One offscreen render at a time, cached; the vote screen shares the cache.
  const shots = useLevelshots(maps.map((m) => m.id));
  return (
    <div className='flex flex-col gap-2'>
      <div className='lb-field-label'>
        <span>{label}</span>
        <b>{mapParts(value).name}</b>
      </div>
      <div className='lb-maps' role='radiogroup' aria-label={label}>
        {maps.map((m) => (
          <MapCard key={m.id} mapId={m.id} active={value === m.id} onPick={() => onChange(m.id)} shot={shots[m.id]} />
        ))}
      </div>
    </div>
  );
}
