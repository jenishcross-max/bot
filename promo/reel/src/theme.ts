// Единственный источник цветов, кривых и пружин. В компонентах хардкода нет.
import { Easing } from 'remotion';

export const theme = {
  colors: {
    bg: '#0A0F0D',
    bgAlt: '#141A18',
    surface: '#1B2321',
    // Главный цвет ровно один — зелёный WhatsApp. В кадре он максимум на одном элементе.
    primary: '#25D366',
    // Тёплый акцент под бьюти-тему: мелкие детали, иконки, подписи.
    accent: '#E9B872',
    text: '#F4F2ED',
    textDim: '#93A09A',
    glow: 'rgba(37, 211, 102, 0.35)',
  },
  // Кривые. Линейной интерполяции в проекте нет.
  ease: {
    out: Easing.bezier(0.16, 1, 0.3, 1),
    inOut: Easing.bezier(0.83, 0, 0.17, 1),
    in: Easing.bezier(0.7, 0, 0.84, 0),
  },
  spring: {
    snappy: { damping: 14, stiffness: 160, mass: 0.6 },
    smooth: { damping: 20, stiffness: 90, mass: 1 },
    bouncy: { damping: 11, stiffness: 170, mass: 0.7 },
  },
  // Кадр 1080x1920: сверху и снизу интерфейс инстаграма, туда ничего важного.
  safe: { top: 250, bottom: 250, side: 90 },
  radius: { card: 40, chip: 999, bubble: 34 },
} as const;
