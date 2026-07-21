import { describe, expect, it } from 'vitest';
import { parseProcessTime, parsePsResourceOutput, parseWindowsResourceOutput } from '../process-resource-sampler.js';

describe('plugin process resource sampler', () => {
  it('parses ps CPU, RSS, and cumulative time for standalone SEA PIDs', () => {
    const values = parsePsResourceOutput('  4102  48128  12.5  1:02.50\n4103 1024 0.0 2-03:04:05\n');
    expect(values.get(4102)).toEqual({
      cpuPercent: 12.5,
      cumulativeCpuSeconds: 62.5,
      residentSetBytes: 48_128 * 1024,
      privateMemoryBytes: 0,
    });
    expect(values.get(4103)?.cumulativeCpuSeconds).toBe(183_845);
  });

  it('rejects malformed process times', () => {
    expect(parseProcessTime('not-a-time')).toBeNull();
  });

  it('derives Windows CPU percent from cumulative samples', () => {
    parseWindowsResourceOutput('{"Id":77,"CPU":1,"WorkingSet64":200,"PrivateMemorySize64":150}', 1_000);
    const values = parseWindowsResourceOutput(
      '{"Id":77,"CPU":1.5,"WorkingSet64":220,"PrivateMemorySize64":160}',
      2_000,
    );
    expect(values.get(77)).toEqual({
      cpuPercent: 50,
      cumulativeCpuSeconds: 1.5,
      residentSetBytes: 220,
      privateMemoryBytes: 160,
    });
  });
});
