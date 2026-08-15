// Фоновая музыка синтезируется здесь, файлов со стороны нет.
// Прошлая версия звучала странно из-за расстроенных осцилляторов и шума в подложке —
// поэтому тут только чистые синусы на нотах аккорда: пэд, арпеджио, мягкий бит.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const DUR = 39.2;
const N = Math.floor(SR * DUR);
const out = new Float32Array(N);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sfx');
mkdirSync(OUT, { recursive: true });

const add = (start, dur, fn) => {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  for (let i = 0; i < n && s0 + i < N; i++) {
    if (s0 + i < 0) continue;
    out[s0 + i] += fn(i / SR, i / n);
  }
};

let seed = 7;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

// 100 BPM: доля 0.6 с, такт 2.4 с. Аккорд держится такт.
const BEAT = 0.6;
const BAR = BEAT * 4;
const A3 = 220, C4 = 261.63, E4 = 329.63, F3 = 174.61, G3 = 196.0, B3 = 246.94, D4 = 293.66, G4 = 392.0;
const PROG = [
  [A3, C4, E4],
  [F3, A3, C4],
  [C4, E4, G4],
  [G3, B3, D4],
];

// Пэд: три чистых тона аккорда, мягкий вход и выход, без биений.
for (let bar = 0; bar * BAR < DUR; bar++) {
  const chord = PROG[bar % PROG.length];
  add(bar * BAR, BAR + 0.6, (ts, p) => {
    const env = Math.min(1, ts / 0.5) * Math.min(1, (1 - p) * 4);
    let v = 0;
    for (const f of chord) v += Math.sin(2 * Math.PI * f * ts);
    return (v / chord.length) * 0.16 * env;
  });
  // Суб-бас: корень аккорда октавой ниже, он держит всё вместе.
  add(bar * BAR, BAR, (ts, p) => {
    const env = Math.min(1, ts / 0.25) * Math.min(1, (1 - p) * 5);
    return Math.sin(2 * Math.PI * (chord[0] / 2) * ts) * 0.13 * env;
  });
}

// Арпеджио восьмыми — появляется на 7-й секунде, уходит к финалу.
for (let e = 0; e * (BEAT / 2) < DUR; e++) {
  const t = e * (BEAT / 2);
  if (t < 7 || t > 32) continue;
  const chord = PROG[Math.floor(t / BAR) % PROG.length];
  const f = chord[e % chord.length] * 2;
  const soft = t > 29 ? Math.max(0, 1 - (t - 29) / 3) : 1;
  add(t, 0.42, (ts, p) => Math.sin(2 * Math.PI * f * ts) * Math.exp(-p * 5.5) * 0.09 * soft);
}

// Мягкий кик на первую и третью долю — держит темп, но не выпирает.
for (let b = 0; b * BEAT < DUR; b++) {
  const t = b * BEAT;
  if (t < 4 || t > 33) continue;
  if (b % 2 !== 0) continue;
  add(t, 0.3, (ts, p) => {
    const f = 95 - 50 * Math.min(1, ts * 12);
    return Math.sin(2 * Math.PI * f * ts) * Math.exp(-p * 8) * 0.42;
  });
}

// Хэт на слабую долю, еле слышный: даёт воздух, а не ритм.
for (let b = 0; b * BEAT < DUR; b++) {
  const t = b * BEAT + BEAT / 2;
  if (t < 11 || t > 31) continue;
  add(t, 0.035, (ts, p) => rnd() * 2 * Math.exp(-p * 12) * 0.05);
}

// Общий контур громкости: вступление, провал под голос, подъём в финале.
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fadeIn = Math.min(1, t / 1.6);
  const fadeOut = Math.min(1, (DUR - t) / 2.2);
  // Под голосом (0.5–36.5 с) музыка сидит тише — голос всегда главнее.
  const duck = t > 0.5 && t < 37.2 ? 0.72 : 1;
  out[i] *= fadeIn * fadeOut * duck;
}

let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(out[i]));
const g = 0.88 / peak;

const buf = Buffer.alloc(44 + N * 2);
buf.write('RIFF', 0);
buf.writeUInt32LE(36 + N * 2, 4);
buf.write('WAVE', 8);
buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write('data', 36);
buf.writeUInt32LE(N * 2, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, out[i] * g)) * 32767), 44 + i * 2);
}
writeFileSync(join(OUT, 'music.wav'), buf);
console.log('music.wav готов, пик до нормализации', peak.toFixed(2));
