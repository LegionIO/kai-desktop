import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_PROCESS_PROTOCOL_VERSION } from '../plugin-runtime.js';

describe('plugin process protocol version', () => {
  it('matches the full-update sentinel in package.json', () => {
    const packageMetadata = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      pluginProcessProtocolVersion?: unknown;
    };

    expect(PLUGIN_PROCESS_PROTOCOL_VERSION).toBe(packageMetadata.pluginProcessProtocolVersion);
  });
});
