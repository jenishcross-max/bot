// 21.5–25.1 с — «прислали фото причёски, подскажет, какая это услуга».
// Показываем именно переписку: большая картинка сама по себе не читается как
// «клиент прислал фото», а вложение в пузыре — читается сразу.
import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { theme } from '../theme';
import { Entrance, Scene } from '../components/Motion';
import { Bubble, Kicker } from '../components/Ui';
import { Camera } from '../components/Icons';

// Настоящей фотографии клиента у нас нет, и ставить чужое фото в рекламу нельзя.
// Рисуем силуэт — честнее и не отвлекает от смысла сцены.
const Attachment: React.FC = () => {
  const frame = useCurrentFrame();
  // Кен Бёрнс: даже нарисованная картинка обязана медленно жить.
  const scale = interpolate(frame, [0, 108], [1, 1.1], {
    easing: theme.ease.inOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const pan = interpolate(frame, [0, 108], [0, -14], {
    easing: theme.ease.inOut,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        width: 470,
        height: 380,
        borderRadius: 26,
        overflow: 'hidden',
        background: `linear-gradient(160deg, ${theme.colors.accent}33, #0E1512 70%)`,
      }}
    >
      <svg
        viewBox="0 0 400 320"
        width="100%"
        height="100%"
        style={{ transform: `scale(${scale}) translateX(${pan}px)`, display: 'block' }}
      >
        <defs>
          <linearGradient id="hair" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={theme.colors.accent} stopOpacity="0.95" />
            <stop offset="100%" stopColor={theme.colors.accent} stopOpacity="0.4" />
          </linearGradient>
        </defs>
        {/* волосы: шапка и две пряди по бокам */}
        <path
          d="M200 54 c56 0 88 42 88 96 c0 52 -8 96 -18 138 h-34 c12 -44 16 -84 16 -118
             c0 -34 -22 -56 -52 -56 c-30 0 -52 22 -52 56 c0 34 4 74 16 118 h-34
             c-10 -42 -18 -86 -18 -138 c0 -54 32 -96 88 -96 z"
          fill="url(#hair)"
        />
        <ellipse cx="200" cy="150" rx="44" ry="54" fill={theme.colors.text} opacity="0.92" />
        <path
          d="M138 320 c0 -44 28 -74 62 -74 c34 0 62 30 62 74 z"
          fill={theme.colors.text}
          opacity="0.5"
        />
      </svg>
    </div>
  );
};

export const Photo: React.FC<{ dur: number }> = ({ dur }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = spring({ frame: frame - 4, fps, config: theme.spring.smooth });

  return (
    <Scene dur={dur} style={{ gap: 40 }}>
      <Entrance delay={0} preset="snappy" from={20}>
        <Kicker>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 16 }}>
            <Camera size={34} strokeWidth={5} />
            фото вместо описания
          </span>
        </Kicker>
      </Entrance>

      <div
        style={{
          width: '100%',
          opacity: card,
          transform: `translateY(${interpolate(card, [0, 1], [70, 0])}px) scale(${interpolate(
            card,
            [0, 1],
            [0.93, 1]
          )})`,
        }}
      >
        <Bubble side="in" time="14:06">
          <Attachment />
          <div style={{ marginTop: 18, fontSize: 32, color: theme.colors.textDim }}>
            хочу вот так, сколько выйдет?
          </div>
        </Bubble>
      </div>

      <Entrance delay={38} preset="snappy" from={28} style={{ width: '100%' }}>
        {/* Неразрывный пробел в сумме: иначе «2 500» разъезжается по двум строкам. */}
        <Bubble side="out" time="14:06" glow>
          Похоже на балаяж — 2&#160;500&#160;с, около 3 часов
        </Bubble>
      </Entrance>
    </Scene>
  );
};
