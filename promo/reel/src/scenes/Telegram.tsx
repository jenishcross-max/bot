// 25.1–30.7 с — расплата за всё предыдущее: владелец открывает Телеграм и видит день.
// Здесь самая крупная анимация ролика, дальше только затухание к призыву.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene, useFloat } from '../components/Motion';
import { Card, Kicker } from '../components/Ui';
import { Calendar } from '../components/Icons';

const ROWS = [
  { time: '10:00', name: 'Азамат', service: 'Стрижка мужская', master: 'Айгуль' },
  { time: '14:00', name: 'Нурия', service: 'Окрашивание', master: 'Динара' },
];

const Row: React.FC<{ row: (typeof ROWS)[number]; delay: number }> = ({ row, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: theme.spring.smooth });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 30,
        padding: '32px 0',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        opacity: p,
        transform: `translateX(${interpolate(p, [0, 1], [70, 0])}px)`,
      }}
    >
      <div
        style={{
          fontSize: 52,
          fontWeight: 800,
          color: theme.colors.text,
          fontVariantNumeric: 'tabular-nums',
          minWidth: 160,
        }}
      >
        {row.time}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 46, fontWeight: 700, color: theme.colors.text }}>
          {row.name}
        </div>
        <div style={{ fontSize: 32, color: theme.colors.textDim }}>
          {row.service} · мастер {row.master}
        </div>
      </div>
    </div>
  );
};

export const Telegram: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = spring({ frame: frame - 6, fps, config: theme.spring.smooth });
  const float = useFloat(38, 6);

  return (
    <Scene dur={dur} style={{ gap: 44 }}>
      <Entrance delay={0} preset="snappy" from={22}>
        <Kicker>а вы просто открываете телеграм</Kicker>
      </Entrance>

      <div
        style={{
          width: '100%',
          opacity: card,
          transform: `translateY(${interpolate(card, [0, 1], [90, 0]) + float}px) scale(${interpolate(
            card,
            [0, 1],
            [0.9, 1]
          )})`,
        }}
      >
        <Card>
          <div style={{ display: 'flex', alignItems: 'center', gap: 22, paddingBottom: 30 }}>
            <Calendar size={54} color={theme.colors.primary} strokeWidth={4.5} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 48, fontWeight: 800, color: theme.colors.text }}>
                Записи на сегодня
              </div>
              <div style={{ fontSize: 30, color: theme.colors.textDim }}>
                15 августа, суббота
              </div>
            </div>
          </div>

          {ROWS.map((row, i) => (
            <Row key={row.name} row={row} delay={38 + i * 22} />
          ))}
        </Card>
      </div>

      <Entrance delay={96} preset="snappy" from={26}>
        <div style={{ fontSize: 40, color: theme.colors.textDim, textAlign: 'center' }}>
          записались, пока вы работали
        </div>
      </Entrance>
    </Scene>
  );
};
