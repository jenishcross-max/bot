// Иконки рисуем сами. Эмодзи рендерятся системными цветными глифами: они игнорируют
// палитру и на тёмном фоне превращаются в мусор.
import React from 'react';

type P = { size?: number; color?: string; strokeWidth?: number };

const Svg: React.FC<P & { children: React.ReactNode }> = ({
  size = 64,
  color = 'currentColor',
  strokeWidth = 5,
  children,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

export const Scissors: React.FC<P> = (p) => (
  <Svg {...p}>
    <circle cx="16" cy="49" r="8" />
    <circle cx="48" cy="49" r="8" />
    <path d="M22 43 L46 11" />
    <path d="M42 43 L18 11" />
  </Svg>
);

export const Brush: React.FC<P> = (p) => (
  <Svg {...p}>
    <path d="M40 10 L54 24 L30 48 L16 34 Z" />
    <path d="M16 34 L10 54 L30 48" />
  </Svg>
);

export const Nail: React.FC<P> = (p) => (
  <Svg {...p}>
    <path d="M24 14 a8 8 0 0 1 16 0 v26 a8 8 0 0 1 -16 0 Z" />
    <path d="M24 30 h16" />
    <path d="M20 54 h24" />
  </Svg>
);

export const Clock: React.FC<P> = (p) => (
  <Svg {...p}>
    <circle cx="32" cy="32" r="23" />
    <path d="M32 18 V33 L42 39" />
  </Svg>
);

export const Calendar: React.FC<P> = (p) => (
  <Svg {...p}>
    <rect x="9" y="14" width="46" height="42" rx="7" />
    <path d="M9 26 H55" />
    <path d="M21 8 V18 M43 8 V18" />
  </Svg>
);

export const Camera: React.FC<P> = (p) => (
  <Svg {...p}>
    <rect x="7" y="18" width="50" height="36" rx="8" />
    <circle cx="32" cy="36" r="11" />
    <path d="M23 18 L27 11 H37 L41 18" />
  </Svg>
);

export const Check: React.FC<P> = (p) => (
  <Svg {...p}>
    <path d="M13 34 L26 46 L51 19" />
  </Svg>
);

export const Cross: React.FC<P> = (p) => (
  <Svg {...p}>
    <path d="M18 18 L46 46 M46 18 L18 46" />
  </Svg>
);

export const Bell: React.FC<P> = (p) => (
  <Svg {...p}>
    <path d="M17 44 V30 a15 15 0 0 1 30 0 v14 l5 7 H12 Z" />
    <path d="M27 51 a5 5 0 0 0 10 0" />
  </Svg>
);
