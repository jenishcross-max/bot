import React from 'react';
import { Composition } from 'remotion';
import { Reel } from './Reel';
import { DURATION, FPS, HEIGHT, WIDTH } from './timeline';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="SalonReel"
      component={Reel}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
