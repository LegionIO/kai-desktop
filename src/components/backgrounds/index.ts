import type { FC } from 'react';
import Matrix from './Matrix';
import Constellations from './Constellations';
import Hexagons from './Hexagons';

/** All available animated backgrounds. Add new backgrounds here. */
export const backgrounds: FC[] = [
  Matrix,
  Constellations,
  Hexagons,
];
