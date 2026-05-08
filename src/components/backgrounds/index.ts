import type { FC } from 'react';
import Matrix from './Matrix';
import Constellations from './Constellations';
import Hexagons from './Hexagons';
import Smokescreen from './Smokescreen';

/** All available animated backgrounds. Add new backgrounds here. */
export const backgrounds: FC[] = [
  Matrix,
  Constellations,
  Hexagons,
  Smokescreen,
];

/** Human-readable names for each background, in the same order as `backgrounds`. */
export const backgroundNames: string[] = [
  'Matrix',
  'Constellations',
  'Hexagons',
  'Smokescreen',
];
