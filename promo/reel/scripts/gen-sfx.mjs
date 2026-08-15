// Звуки интерфейса. Все выше 400 Гц, чтобы не спорить с голосом и суб-басом музыки.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sfx');
mkdirSync(OUT, { recursive: true });

const secs = (s) => Math.round(s * SR);

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
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
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return buf;
}

let seed = 3;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

// whoosh — короткий воздух на склейке
{
  const N = secs(0.34);
  const s = new Float32Array(N);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const env = Math.sin(Math.PI * Math.pow(t, 0.65)) ** 2;
    const x = rnd() * 2;
    // Простейший highpass: убирает низ, оставляет «воздух».
    hp = 0.86 * (hp + x - prev);
    prev = x;
    s[i] = hp * env * 0.5;
  }
  writeFileSync(join(OUT, 'whoosh.wav'), wav(s));
}

// pop — приход сообщения
{
  const N = secs(0.13);
  const s = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const f = 1250 - 520 * t;
    ph += (2 * Math.PI * f) / SR;
    s[i] = Math.sin(ph) * Math.exp(-t * 10) * 0.5;
  }
  writeFileSync(join(OUT, 'pop.wav'), wav(s));
}

// tick — строка списка
{
  const N = secs(0.05);
  const s = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    ph += (2 * Math.PI * 2100) / SR;
    s[i] = Math.sin(ph) * Math.exp(-t * 22) * 0.28;
  }
  writeFileSync(join(OUT, 'tick.wav'), wav(s));
}

// thump — нажатие кнопки: щелчок плюс короткий низ
{
  const N = secs(0.2);
  const s = new Float32Array(N);
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / N;
    const f = 520 - 260 * t;
    ph += (2 * Math.PI * f) / SR;
    s[i] = (Math.sin(ph) * 0.6 + rnd() * 0.6 * Math.exp(-t * 40)) * Math.exp(-t * 12) * 0.55;
  }
  writeFileSync(join(OUT, 'thump.wav'), wav(s));
}

// shimmer — призыв в финале
{
  const N = secs(0.9);
  const s = new Float32Array(N);
  const tones = [1046.5, 1318.5, 1568.0];
  for (let i = 0; i < N; i++) {
    const t = i / N;
    let v = 0;
    tones.forEach((f, k) => {
      const start = k * 0.12;
      const tt = t - start;
      if (tt <= 0) return;
      v += Math.sin(2 * Math.PI * f * (i / SR)) * Math.exp(-tt * 4.5);
    });
    s[i] = (v / tones.length) * 0.4;
  }
  writeFileSync(join(OUT, 'shimmer.wav'), wav(s));
}

console.log('sfx готовы: whoosh, pop, tick, thump, shimmer');
