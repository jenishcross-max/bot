// Сборка ролика: слои, сцены по таймингам озвучки, звук.
import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from 'remotion';
import { loadFont } from '@remotion/google-fonts/Montserrat';
import { theme } from './theme';
import { BgMesh, Grade, Grain, Vignette } from './components/Layers';
import { CUTS, SCENES } from './timeline';
import { Hook } from './scenes/Hook';
import { Chat } from './scenes/Chat';
import { Prices } from './scenes/Prices';
import { Slots } from './scenes/Slots';
import { Photo } from './scenes/Photo';
import { Telegram } from './scenes/Telegram';
import { Done } from './scenes/Done';
import { Cta } from './scenes/Cta';

// Системный шрифт для заголовков запрещён: на чужой машине он подменится.
const { fontFamily } = loadFont('normal', {
  weights: ['500', '600', '700', '800'],
  subsets: ['cyrillic', 'latin'],
});

const SCENE_COMPONENTS: Record<string, React.FC<{ dur: number }>> = {
  hook: Hook,
  chat: Chat,
  prices: Prices,
  slots: Slots,
  photo: Photo,
  telegram: Telegram,
  done: Done,
  cta: Cta,
};

// Звук ставится на 3 кадра раньше картинки: так мозг слышит «вместе»,
// а точное совпадение воспринимается как опоздание.
const LEAD = 3;
const POPS = [265, 351, 387, 571, 679];
const TICKS = [432, 437, 442, 791, 813];
const THUMPS = [947];
const SHIMMERS = [1084];

const Sfx: React.FC<{ at: number; file: string; volume: number }> = ({
  at,
  file,
  volume,
}) => (
  <Sequence from={Math.max(0, at - LEAD)} durationInFrames={40} layout="none">
    <Audio src={staticFile(`sfx/${file}`)} volume={volume} />
  </Sequence>
);

export const Reel: React.FC = () => (
  <AbsoluteFill style={{ fontFamily, backgroundColor: theme.colors.bg }}>
    <BgMesh />

    {SCENES.map((scene) => {
      const Comp = SCENE_COMPONENTS[scene.id];
      return (
        <Sequence key={scene.id} from={scene.from} durationInFrames={scene.dur}>
          <Comp dur={scene.dur} />
        </Sequence>
      );
    })}

    <Grade />
    <Grain />
    <Vignette />

    <Audio src={staticFile('voice.mp3')} />

    <Audio
      src={staticFile('sfx/music.wav')}
      volume={(f) =>
        // После последней фразы музыка чуть подрастает и уводится в тишину.
        interpolate(f, [0, 30, 1105, 1130, 1165], [0, 0.16, 0.16, 0.2, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      }
    />

    {CUTS.map((cut) => (
      <Sfx key={`w${cut}`} at={cut} file="whoosh.wav" volume={0.32} />
    ))}
    {POPS.map((at) => (
      <Sfx key={`p${at}`} at={at} file="pop.wav" volume={0.3} />
    ))}
    {TICKS.map((at) => (
      <Sfx key={`t${at}`} at={at} file="tick.wav" volume={0.26} />
    ))}
    {THUMPS.map((at) => (
      <Sfx key={`th${at}`} at={at} file="thump.wav" volume={0.32} />
    ))}
    {SHIMMERS.map((at) => (
      <Sfx key={`s${at}`} at={at} file="shimmer.wav" volume={0.24} />
    ))}
  </AbsoluteFill>
);
