// 4.5–14.1 с — телефон и живая переписка: клиент пишет ночью, бот отвечает и записывает.
// Сцена длинная, поэтому внутри неё новый элемент появляется каждые 2–3 секунды.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene, WordReveal } from '../components/Motion';
import { Bubble, Phone, Typing } from '../components/Ui';
import { Check } from '../components/Icons';

// Первый обмен нужен не только для смысла, но и композиционно: с двумя пузырями
// экран телефона наполовину пустой, и кадр выглядит недоделанным.
const ASK_AT = 34;
const ANSWER_AT = 68;
const CLIENT_AT = 130;
const TYPING_AT = 186;
const BOT_AT = 216;
const BADGE_AT = 252;

export const Chat: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phone = spring({ frame: frame - 6, fps, config: theme.spring.smooth });
  const badge = spring({ frame: frame - BADGE_AT, fps, config: theme.spring.bouncy });
  const typingVisible = frame >= TYPING_AT && frame < BOT_AT;

  return (
    <Scene dur={dur} style={{ justifyContent: 'flex-start', gap: 42 }}>
      <WordReveal
        text="Записывает клиентов сам"
        delay={4}
        per={3}
        highlight="сам"
        style={{
          justifyContent: 'center',
          fontSize: 78,
          fontWeight: 800,
          letterSpacing: '-0.03em',
          textAlign: 'center',
          color: theme.colors.text,
        }}
      />

      <div
        style={{
          opacity: phone,
          transform: `translateY(${interpolate(phone, [0, 1], [120, 0])}px) scale(${interpolate(
            phone,
            [0, 1],
            [0.92, 1]
          )})`,
        }}
      >
        <Phone title="Салон «Айым»" subtitle="отвечает сразу" width={760} height={1080}>
          <div style={{ flex: 1 }} />

          {frame >= ASK_AT ? (
            <Entrance delay={ASK_AT} preset="snappy" from={26}>
              <Bubble side="in" time="01:12">
                Здравствуйте! Сколько стоит стрижка?
              </Bubble>
            </Entrance>
          ) : null}

          {frame >= ANSWER_AT ? (
            <Entrance delay={ANSWER_AT} preset="snappy" from={26}>
              <Bubble side="out" time="01:12">
                Мужская — 500 с. Записать вас?
              </Bubble>
            </Entrance>
          ) : null}

          {frame >= CLIENT_AT ? (
            <Entrance delay={CLIENT_AT} preset="snappy" from={26}>
              <Bubble side="in" time="01:14">
                а можно завтра в три?
              </Bubble>
            </Entrance>
          ) : null}

          {typingVisible ? <Typing frame={frame - TYPING_AT} /> : null}

          {frame >= BOT_AT ? (
            <Entrance delay={BOT_AT} preset="snappy" from={26}>
              <Bubble side="out" time="01:14" glow>
                Записываю на завтра, 15:00. Как вас записать?
              </Bubble>
            </Entrance>
          ) : null}

          {frame >= BADGE_AT ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 16,
                alignSelf: 'center',
                padding: '18px 34px',
                borderRadius: theme.radius.chip,
                background: `${theme.colors.accent}1F`,
                border: `1px solid ${theme.colors.accent}55`,
                color: theme.colors.accent,
                fontSize: 28,
                fontWeight: 700,
                opacity: badge,
                transform: `scale(${interpolate(badge, [0, 1], [0.82, 1])})`,
              }}
            >
              <Check size={32} strokeWidth={6} />
              запись создана
            </div>
          ) : null}
        </Phone>
      </div>
    </Scene>
  );
};
