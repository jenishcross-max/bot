// 33.3–37.6 с — призыв. Он спокойный: после быстрой части глаз должен отдохнуть
// и прочитать одно действие. Светится ровно один элемент — плашка с «ИИ».
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene, WordReveal, useBreathe } from '../components/Motion';
import { Kicker } from '../components/Ui';

const PILL_AT = 84;

export const Cta: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pill = spring({ frame: frame - PILL_AT, fps, config: theme.spring.bouncy });
  const breathe = useBreathe(24, 0.014);
  const glow = 0.6 + Math.max(0, Math.sin((frame - PILL_AT) / 12)) * 0.4;

  return (
    <Scene dur={dur} style={{ gap: 54 }}>
      <Entrance delay={2} preset="snappy" from={22}>
        <Kicker>подключение</Kicker>
      </Entrance>

      <WordReveal
        text="Вашему салону за один день"
        delay={8}
        per={3}
        style={{
          justifyContent: 'center',
          textAlign: 'center',
          fontSize: 92,
          fontWeight: 800,
          letterSpacing: '-0.03em',
          lineHeight: 1.08,
          color: theme.colors.text,
        }}
      />

      <Entrance delay={46} preset="smooth" from={30}>
        <div
          style={{
            fontSize: 42,
            color: theme.colors.textDim,
            textAlign: 'center',
            lineHeight: 1.35,
          }}
        >
          отвечает, записывает и напоминает —
          <br />
          пока вы стрижёте
        </div>
      </Entrance>

      {frame >= PILL_AT ? (
        <div
          style={{
            marginTop: 20,
            padding: '34px 62px',
            borderRadius: theme.radius.chip,
            background: theme.colors.primary,
            color: '#062B15',
            fontSize: 52,
            fontWeight: 800,
            textAlign: 'center',
            opacity: pill,
            transform: `scale(${interpolate(pill, [0, 1], [0.7, 1]) * breathe})`,
            boxShadow: `0 0 ${70 * glow}px ${theme.colors.glow}, 0 30px 70px -26px ${theme.colors.glow}`,
          }}
        >
          Напишите «ИИ» в комментариях
        </div>
      ) : null}
    </Scene>
  );
};
