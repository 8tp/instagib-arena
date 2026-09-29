import type { ReactNode } from 'react';

// Small stroke icons for the settings rail. 20px grid, currentColor.
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden
    >
      {children}
    </svg>
  );
}

export const IconControls = () => (
  <Svg>
    <rect x='2' y='5' width='16' height='10' rx='1.5' />
    <path d='M5 8.5h1M8 8.5h1M11 8.5h1M14 8.5h1M6 11.5h8' />
  </Svg>
);
export const IconCrosshair = () => (
  <Svg>
    <circle cx='10' cy='10' r='5.5' />
    <path d='M10 1.5v4M10 14.5v4M1.5 10h4M14.5 10h4' />
  </Svg>
);
export const IconVideo = () => (
  <Svg>
    <rect x='2' y='3.5' width='16' height='10.5' rx='1.5' />
    <path d='M7 17h6M10 14v3' />
  </Svg>
);
export const IconAudio = () => (
  <Svg>
    <path d='M3 8v4h3l4.5 3.5v-11L6 8H3z' />
    <path d='M13.5 7.5a3.5 3.5 0 010 5M15.5 5a6.5 6.5 0 010 10' />
  </Svg>
);
export const IconAccess = () => (
  <Svg>
    <path d='M1.8 10S5 4.5 10 4.5 18.2 10 18.2 10 15 15.5 10 15.5 1.8 10 1.8 10z' />
    <circle cx='10' cy='10' r='2.4' />
  </Svg>
);
export const IconProfile = () => (
  <Svg>
    <circle cx='10' cy='7' r='3.2' />
    <path d='M3.5 17c.8-3.2 3.3-5 6.5-5s5.7 1.8 6.5 5' />
  </Svg>
);
export const IconSearch = () => (
  <Svg size={16}>
    <circle cx='8.5' cy='8.5' r='5' />
    <path d='M12.5 12.5L17 17' />
  </Svg>
);
export const IconReset = () => (
  <Svg size={14}>
    <path d='M4 10a6 6 0 106-6H6.5' />
    <path d='M8.5 1.5L6 4l2.5 2.5' />
  </Svg>
);
export const IconClear = () => (
  <Svg size={14}>
    <path d='M5 5l10 10M15 5L5 15' />
  </Svg>
);
