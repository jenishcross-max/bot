// Интерфейсные примитивы: телефон, пузыри переписки, карточки, чипы.
import React from 'react';
import { theme } from '../theme';
import { useBreathe, useFloat } from './Motion';

export const Phone: React.FC<{
  title: string;
  subtitle?: string;
  accent?: string;
  width?: number;
  height?: number;
  breathe?: boolean;
  children: React.ReactNode;
}> = ({
  title,
  subtitle,
  accent = theme.colors.primary,
  width = 700,
  height = 1180,
  breathe = true,
  children,
}) => {
  const scale = useBreathe(26, 0.008);
  const float = useFloat(34, 5);

  return (
    <div
      style={{
        width,
        height,
        borderRadius: 62,
        background: theme.colors.bgAlt,
        border: '2px solid rgba(255,255,255,0.10)',
        boxShadow: '0 60px 120px -30px rgba(0,0,0,0.75)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        transform: breathe ? `scale(${scale}) translateY(${float}px)` : undefined,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 22,
          padding: '34px 34px 30px',
          background: 'rgba(255,255,255,0.045)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <div
          style={{
            width: 74,
            height: 74,
            borderRadius: '50%',
            background: `${accent}26`,
            border: `2px solid ${accent}66`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accent,
            fontSize: 34,
            fontWeight: 700,
          }}
        >
          {title.slice(0, 1)}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 34, fontWeight: 700, color: theme.colors.text }}>
            {title}
          </div>
          {subtitle ? (
            <div style={{ fontSize: 25, color: theme.colors.textDim }}>{subtitle}</div>
          ) : null}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          padding: '34px 30px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {children}
      </div>
    </div>
  );
};

export const Bubble: React.FC<{
  side: 'in' | 'out';
  time?: string;
  // Светится только последний ответ бота. Если подсветить все зелёные пузыри,
  // кадр превращается в гирлянду и взгляду не за что зацепиться.
  glow?: boolean;
  children: React.ReactNode;
}> = ({ side, time, glow = false, children }) => {
  const out = side === 'out';

  return (
    <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '84%',
          padding: '26px 30px 20px',
          borderRadius: theme.radius.bubble,
          borderBottomRightRadius: out ? 10 : theme.radius.bubble,
          borderBottomLeftRadius: out ? theme.radius.bubble : 10,
          background: out ? theme.colors.primary : theme.colors.surface,
          color: out ? '#062B15' : theme.colors.text,
          fontSize: 34,
          lineHeight: 1.32,
          fontWeight: out ? 600 : 500,
          boxShadow: glow ? `0 22px 70px -18px ${theme.colors.glow}` : 'none',
        }}
      >
        {children}
        {time ? (
          <div
            style={{
              marginTop: 10,
              fontSize: 22,
              textAlign: 'right',
              opacity: 0.62,
            }}
          >
            {time}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export const Typing: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '28px 32px',
        borderRadius: theme.radius.bubble,
        background: theme.colors.surface,
      }}
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: theme.colors.textDim,
            opacity: 0.35 + 0.65 * Math.max(0, Math.sin((frame - i * 3) / 3.2)),
          }}
        />
      ))}
    </div>
  </div>
);

export const Card: React.FC<{
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ style, children }) => (
  <div
    style={{
      width: '100%',
      borderRadius: theme.radius.card,
      background: 'rgba(255,255,255,0.045)',
      border: '1px solid rgba(255,255,255,0.09)',
      boxShadow: '0 46px 90px -34px rgba(0,0,0,0.7)',
      padding: 44,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Kicker: React.FC<{ children: React.ReactNode; color?: string }> = ({
  children,
  color = theme.colors.accent,
}) => (
  <div
    style={{
      fontSize: 30,
      letterSpacing: 4,
      textTransform: 'uppercase',
      fontWeight: 700,
      color,
      opacity: 0.85,
    }}
  >
    {children}
  </div>
);
