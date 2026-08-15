// Движение: входы, стаггер, уходы, дыхание. Ничего не появляется просто прозрачностью
// и ничего не появляется одновременно — от этого ролик выглядит сгенерированным.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';

type Preset = keyof typeof theme.spring;

export const Entrance: React.FC<{
  delay?: number;
  preset?: Preset;
  from?: number;
  scaleFrom?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay = 0, preset = 'smooth', from = 44, scaleFrom = 0.94, style, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: theme.spring[preset] });

  return (
    <div
      style={{
        opacity: p,
        transform: `translateY(${interpolate(p, [0, 1], [from, 0])}px) scale(${interpolate(
          p,
          [0, 1],
          [scaleFrom, 1]
        )})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const WordReveal: React.FC<{
  text: string;
  delay?: number;
  per?: number;
  highlight?: string;
  style?: React.CSSProperties;
}> = ({ text, delay = 0, per = 3, highlight, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    // Пиксельный gap, а не em: em считается от размера шрифта родителя (16px),
    // и между 90-пиксельными словами получилась бы щель в ноль.
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, ...style }}>
      {text.split(' ').map((word, i) => {
        const p = spring({
          frame: frame - delay - i * per,
          fps,
          config: theme.spring.snappy,
        });
        const isHero = highlight ? word.replace(/[.,!?»«]/g, '') === highlight : false;

        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: p,
              color: isHero ? theme.colors.primary : undefined,
              textShadow: isHero ? `0 0 46px ${theme.colors.glow}` : undefined,
              transform: `translateY(${interpolate(p, [0, 1], [34, 0])}px)`,
            }}
          >
            {word}
          </span>
        );
      })}
    </div>
  );
};

// Обёртка сцены: уход быстрее входа, поэтому 12 кадров против ~20.
export const Scene: React.FC<{
  dur: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ dur, children, style }) => {
  const frame = useCurrentFrame();
  const y = interpolate(frame, [dur - 12, dur - 2], [0, -46], {
    easing: theme.ease.in,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const o = interpolate(frame, [dur - 12, dur - 2], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        padding: `${theme.safe.top}px ${theme.safe.side}px ${theme.safe.bottom}px`,
        opacity: o,
        transform: `translateY(${y}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

// Всё, что живёт в кадре дольше двух секунд, должно едва заметно дышать.
export const useBreathe = (speed = 22, amount = 0.012) => {
  const frame = useCurrentFrame();
  return 1 + Math.sin(frame / speed) * amount;
};

export const useFloat = (speed = 30, px = 4) => {
  const frame = useCurrentFrame();
  return Math.sin(frame / speed) * px;
};
