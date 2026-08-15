// 14.1–17.5 с — «знает ваши услуги, цены и свободное время». Цены не появляются
// готовыми: счётчик добегает до суммы, глаз цепляется за движение цифр.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene } from '../components/Motion';
import { Card, Kicker } from '../components/Ui';

const ROWS = [
  { name: 'Стрижка мужская', price: 500 },
  { name: 'Окрашивание', price: 2500 },
  { name: 'Маникюр', price: 800 },
];

const Price: React.FC<{ value: number; delay: number }> = ({ value, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: { damping: 30, stiffness: 55 } });
  const shown = Math.round(interpolate(p, [0, 1], [0, value]) / 10) * 10;

  return (
    <span
      style={{
        fontVariantNumeric: 'tabular-nums',
        fontSize: 50,
        fontWeight: 800,
        color: theme.colors.text,
      }}
    >
      {shown.toLocaleString('ru-RU')} <span style={{ color: theme.colors.textDim }}>с</span>
    </span>
  );
};

export const Prices: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur} style={{ gap: 44 }}>
    <Entrance delay={2} preset="snappy" from={20}>
      <Kicker>ваш прайс — у бота в голове</Kicker>
    </Entrance>

    <Card>
      {ROWS.map((row, i) => (
        <Entrance key={row.name} delay={8 + i * 5} preset="smooth" from={34}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 32,
              padding: '30px 0',
              borderBottom:
                i === ROWS.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <span style={{ fontSize: 46, fontWeight: 600, color: theme.colors.text }}>
              {row.name}
            </span>
            <Price value={row.price} delay={14 + i * 5} />
          </div>
        </Entrance>
      ))}
    </Card>

    <Entrance delay={30} preset="snappy" from={24}>
      <div style={{ fontSize: 40, color: theme.colors.textDim, textAlign: 'center' }}>
        и свободное время каждого мастера
      </div>
    </Entrance>
  </Scene>
);
