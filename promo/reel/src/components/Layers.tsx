// Пять слоёв кадра: фоновая дымка -> контент -> цветокор -> зерно -> виньетка.
// Плоский фон выглядит самоделкой, поэтому фон всегда живой.
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { theme } from '../theme';

export const BgMesh: React.FC = () => {
  const frame = useCurrentFrame();
  const d1 = Math.sin(frame / 62) * 60;
  const d2 = Math.cos(frame / 78) * 46;
  const d3 = Math.sin(frame / 95) * 34;

  return (
    <AbsoluteFill style={{ background: theme.colors.bg }}>
      <div
        style={{
          position: 'absolute',
          width: 1500,
          height: 1500,
          borderRadius: '50%',
          top: -560 + d3,
          left: -380 + d1,
          filter: 'blur(60px)',
          background: `radial-gradient(circle, ${theme.colors.primary}2E, transparent 62%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 1150,
          height: 1150,
          borderRadius: '50%',
          bottom: -430,
          right: -300 - d2,
          filter: 'blur(80px)',
          background: `radial-gradient(circle, ${theme.colors.accent}1F, transparent 65%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          width: 900,
          height: 900,
          borderRadius: '50%',
          top: 720 + d2 * 0.6,
          right: -260,
          filter: 'blur(90px)',
          background: `radial-gradient(circle, ${theme.colors.primary}14, transparent 68%)`,
        }}
      />
    </AbsoluteFill>
  );
};

export const Grade: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: 'none' }}>
    <AbsoluteFill
      style={{
        backgroundColor: theme.colors.primary,
        mixBlendMode: 'soft-light',
        opacity: 0.2,
      }}
    />
    <AbsoluteFill
      style={{
        background:
          'linear-gradient(180deg, rgba(0,0,0,0.28), transparent 26%, transparent 70%, rgba(0,0,0,0.34))',
      }}
    />
  </AbsoluteFill>
);

export const Grain: React.FC = () => {
  const frame = useCurrentFrame();
  const noise = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;

  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        backgroundImage: noise,
        backgroundSize: '220px',
        // Смещение каждый кадр — иначе зерно «прилипает» и выглядит грязью на линзе.
        backgroundPosition: `${(frame * 7) % 220}px ${(frame * 13) % 220}px`,
        opacity: 0.055,
        mixBlendMode: 'overlay',
      }}
    />
  );
};

export const Vignette: React.FC = () => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      background:
        'radial-gradient(ellipse at center, transparent 54%, rgba(0,0,0,0.34) 100%)',
    }}
  />
);
