import { describe, expect, it } from 'vitest';
import { parseMacOSPrivateMemory } from '../macos-private-memory.js';

describe('macOS plugin private-memory parser', () => {
  it('associates each physical footprint with its PID and ignores the aggregate', () => {
    const output = `
======================================================================
Electron Helper [402]: 64-bit    Footprint: 52428800 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 53477376 B
    phys_footprint_peak: 55050240 B

======================================================================
Plugin [401]: 64-bit    Footprint: 41943040 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 42991616 B
    phys_footprint_peak: 45088768 B

======================================================================
Summary Footprint: 94371840 B
======================================================================
`;

    expect([...parseMacOSPrivateMemory(output)]).toEqual([
      [402, 53_477_376],
      [401, 42_991_616],
    ]);
  });

  it('ignores malformed and unsafe values', () => {
    expect([
      ...parseMacOSPrivateMemory('Plugin [7]: Footprint: 1 B\n  phys_footprint: nope B\nSummary Footprint: 1 B'),
    ]).toEqual([]);
  });
});
