import type { FC } from 'react';
import Matrix from './Matrix';
import Constellation from './Constellation';
import HexGrid from './HexGrid';

/** All available animated backgrounds. Add new backgrounds here. */
export const backgrounds: FC[] = [
  Matrix,
  Constellation,
  HexGrid,
];
