// 30.7–33.3 с — «клиент пришёл, отметили одной кнопкой». Кнопка сначала вжимается,
// и только потом рисуется галочка: без вжатия нажатие не читается.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene } from '../components/Motion';
import { Card, Kicker } from '../components/Ui';

const PRESS_AT = 26;

export const Done: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Вжатие: быстрый уход вниз и упругий возврат.
  const press = interpolate(frame, [PRESS_AT, PRESS_AT + 4, PRESS_AT + 12], [1, 0.92, 1], {
    easing: theme.ease.out,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const done = spring({ frame: frame - PRESS_AT - 4, fps, config: theme.spring.bouncy });
  // Галочка рисуется линией, а не проявляется.
  const draw = interpolate(done, [0, 1], [90, 0]);

  return (
    <Scene dur={dur} style={{ gap: 44 }}>
      <Entrance delay={0} preset="snappy" from={20}>
        <Kicker>клиент пришёл</Kicker>
      </Entrance>

      <Entrance delay={4} preset="smooth" from={40} style={{ width: '100%' }}>
        <Card style={{ padding: 40 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
            <div
              style={{
                width: 92,
                height: 92,
                borderRadius: '50%',
                background: `${theme.colors.primary}${done > 0.1 ? '2E' : '12'}`,
                border: `2px solid ${theme.colors.primary}${done > 0.1 ? 'AA' : '44'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transform: `scale(${interpolate(done, [0, 1], [0.9, 1])})`,
              }}
            >
              <svg width="52" height="52" viewBox="0 0 64 64" fill="none">
                <path
                  d="M13 34 L26 46 L51 19"
                  stroke={theme.colors.primary}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray="90"
                  strokeDashoffset={draw}
                />
              </svg>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <div
                style={{
                  fontSize: 48,
                  fontWeight: 700,
                  color: theme.colors.text,
                  opacity: interpolate(done, [0, 1], [1, 0.55]),
                  textDecoration: done > 0.6 ? 'line-through' : 'none',
                  textDecorationColor: `${theme.colors.textDim}88`,
                }}
              >
                10:00 · Азамат
              </div>
              <div style={{ fontSize: 32, color: theme.colors.textDim }}>
                Стрижка мужская
              </div>
            </div>

            <div
              style={{
                padding: '22px 40px',
                borderRadius: theme.radius.chip,
                background: done > 0.5 ? 'rgba(255,255,255,0.05)' : theme.colors.primary,
                color: done > 0.5 ? theme.colors.textDim : '#062B15',
                fontSize: 34,
                fontWeight: 800,
                transform: `scale(${press})`,
                boxShadow:
                  done > 0.5 ? 'none' : `0 24px 60px -22px ${theme.colors.glow}`,
              }}
            >
              {done > 0.5 ? 'отмечен' : 'пришёл'}
            </div>
          </div>
        </Card>
      </Entrance>

      <Entrance delay={44} preset="snappy" from={24}>
        <div style={{ fontSize: 42, color: theme.colors.textDim, textAlign: 'center' }}>
          одна кнопка — и запись закрыта
        </div>
      </Entrance>
    </Scene>
  );
};
