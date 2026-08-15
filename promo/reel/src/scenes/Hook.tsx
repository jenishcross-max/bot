// 0.0–4.5 с — «Если вы стрижёте, красите или делаете ногти, это для вас».
// Первое движение — на 4-м кадре: в ленте решение листать принимают за полсекунды.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene, WordReveal, useFloat } from '../components/Motion';
import { Brush, Nail, Scissors } from '../components/Icons';
import { Kicker } from '../components/Ui';

const ITEMS = [
  { icon: Scissors, label: 'Стрижёте' },
  { icon: Brush, label: 'Красите' },
  { icon: Nail, label: 'Ногти' },
];

const Chip: React.FC<{ delay: number; index: number; item: (typeof ITEMS)[number] }> = ({
  delay,
  index,
  item,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: theme.spring.bouncy });
  const float = useFloat(26 + index * 4, 6);
  const Icon = item.icon;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 26,
        padding: '26px 44px',
        borderRadius: theme.radius.chip,
        background: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.10)',
        opacity: p,
        transform: `translateX(${interpolate(p, [0, 1], [-70, 0])}px) translateY(${float}px) scale(${interpolate(
          p,
          [0, 1],
          [0.9, 1]
        )})`,
      }}
    >
      <Icon size={58} color={theme.colors.accent} strokeWidth={4.5} />
      <span style={{ fontSize: 52, fontWeight: 700, color: theme.colors.text }}>
        {item.label}
      </span>
    </div>
  );
};

export const Hook: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const line = spring({ frame: frame - 62, fps, config: theme.spring.smooth });

  return (
    <Scene dur={dur} style={{ justifyContent: 'center', gap: 56 }}>
      <Entrance delay={2} preset="snappy" from={22}>
        <Kicker>салоны · барбершопы · мастера</Kicker>
      </Entrance>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {ITEMS.map((item, i) => (
          <Chip key={item.label} item={item} index={i} delay={10 + i * 6} />
        ))}
      </div>

      {/* Линия-разделитель растёт из центра — движение между двумя блоками текста. */}
      <div
        style={{
          width: interpolate(line, [0, 1], [0, 420]),
          height: 4,
          borderRadius: 4,
          background: `linear-gradient(90deg, transparent, ${theme.colors.accent}, transparent)`,
          opacity: 0.7,
        }}
      />

      <WordReveal
        text="Это для вас"
        delay={66}
        per={4}
        highlight="вас"
        style={{
          justifyContent: 'center',
          fontSize: 118,
          fontWeight: 800,
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          color: theme.colors.text,
        }}
      />
    </Scene>
  );
};
