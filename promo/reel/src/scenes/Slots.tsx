// 17.5–21.5 с — «занято предложит другое окошко, а не потеряет клиента».
// Сначала гаснут занятые окна, и только потом загорается свободное: порядок важнее
// самой анимации, иначе зритель не поймёт, что произошло.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene } from '../components/Motion';
import { Kicker } from '../components/Ui';
import { Cross } from '../components/Icons';

const SLOTS = [
  { time: '10:00', busy: true },
  { time: '11:00', busy: true },
  { time: '12:00', busy: true },
  { time: '15:00', busy: false },
  { time: '17:00', busy: true },
  { time: '18:00', busy: true },
];

const FREE_AT = 46;

const Slot: React.FC<{ time: string; busy: boolean; delay: number }> = ({
  time,
  busy,
  delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: theme.spring.snappy });
  const free = spring({ frame: frame - FREE_AT, fps, config: theme.spring.bouncy });
  // Свободное окно пульсирует — единственный светящийся элемент в кадре.
  const pulse = busy ? 0 : Math.max(0, Math.sin((frame - FREE_AT) / 9)) * 0.5;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: '30px 0',
        borderRadius: theme.radius.card,
        background: busy ? 'rgba(255,255,255,0.04)' : theme.colors.primary,
        border: `1px solid ${busy ? 'rgba(255,255,255,0.08)' : theme.colors.primary}`,
        color: busy ? theme.colors.textDim : '#062B15',
        fontSize: 46,
        fontWeight: 800,
        opacity: busy ? p * 0.75 : Math.max(p * 0.2, free),
        boxShadow: busy
          ? 'none'
          : `0 0 ${40 + pulse * 90}px ${theme.colors.glow}, 0 26px 60px -24px ${theme.colors.glow}`,
        transform: `scale(${busy ? interpolate(p, [0, 1], [0.9, 1]) : interpolate(free, [0, 1], [0.7, 1])})`,
      }}
    >
      {busy ? <Cross size={30} strokeWidth={5} color={theme.colors.textDim} /> : null}
      {time}
    </div>
  );
};

export const Slots: React.FC<{ dur: number }> = ({ dur }) => (
  <Scene dur={dur} style={{ gap: 46 }}>
    <Entrance delay={2} preset="snappy" from={20}>
      <Kicker>занято — не значит потеряли</Kicker>
    </Entrance>

    <div
      style={{
        width: '100%',
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 22,
      }}
    >
      {SLOTS.map((slot, i) => (
        <Slot key={slot.time} time={slot.time} busy={slot.busy} delay={6 + i * 4} />
      ))}
    </div>

    <Entrance delay={FREE_AT + 10} preset="smooth" from={30}>
      <div
        style={{
          fontSize: 46,
          fontWeight: 600,
          color: theme.colors.text,
          textAlign: 'center',
          lineHeight: 1.3,
        }}
      >
        «В три занято, но есть 15:00 —
        <br />
        записать вас?»
      </div>
    </Entrance>
  </Scene>
);
