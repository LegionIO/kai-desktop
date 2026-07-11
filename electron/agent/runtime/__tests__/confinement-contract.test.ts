import { describe, it, expect } from 'vitest';
import { MastraRuntime } from '../mastra-runtime.js';
import { ClaudeAgentRuntime } from '../claude-agent-runtime.js';
import { CodexRuntime } from '../codex-runtime.js';
import type { AgentRuntime } from '../types.js';
import { buildAgentChildEnv, resolveConfinedCwd } from '../confinement.js';
import { homedir } from 'node:os';

/**
 * Fail-closed confinement contract (issue #75, part of #66).
 *
 * Guards against capability/enforcement DRIFT: if a new runtime declares
 * `executesUntrustedTools` it must be a consciously-reviewed autonomous
 * runtime, and the confinement primitives it will consume at the IPC
 * chokepoint (#71) must deliver a scrubbed env + a refused-unsafe cwd.
 *
 * NOTE: the end-to-end "the spawned CLI actually received childEnv/confinedCwd"
 * assertion lands with the chokepoint wiring (#71); this test locks the
 * contract those runtimes + helpers must satisfy so the wiring can't regress it.
 */

// The runtimes the app registers in main.ts. Enumerated here (constructed
// directly) rather than via the global registry so the test is deterministic
// and doesn't depend on main.ts bootstrap order.
const ALL_RUNTIMES: AgentRuntime[] = [new MastraRuntime(), new ClaudeAgentRuntime(), new CodexRuntime()];

/** Runtimes that spawn an unsupervised, model-directed tool-running subprocess. */
const KNOWN_AUTONOMOUS = new Set(['claude-agent-sdk', 'codex-sdk', 'pi']);

describe('confinement contract: executesUntrustedTools drift guard', () => {
  it('mastra does NOT execute untrusted tools (in-process behind Kai guards)', () => {
    const mastra = ALL_RUNTIMES.find((r) => r.id === 'mastra');
    expect(mastra).toBeDefined();
    expect(mastra!.capabilities.executesUntrustedTools).toBe(false);
  });

  it('every runtime flagged executesUntrustedTools is a known autonomous runtime', () => {
    // If a new runtime sets the flag, it MUST be added to KNOWN_AUTONOMOUS
    // consciously (and wired through the confinement seam) — this fails first.
    for (const rt of ALL_RUNTIMES) {
      if (rt.capabilities.executesUntrustedTools) {
        expect(
          KNOWN_AUTONOMOUS.has(rt.id),
          `runtime "${rt.id}" is flagged executesUntrustedTools but not reviewed for confinement`,
        ).toBe(true);
      }
    }
  });

  it('the SDK runtimes are flagged (so the chokepoint will confine them)', () => {
    for (const id of ['claude-agent-sdk', 'codex-sdk']) {
      const rt = ALL_RUNTIMES.find((r) => r.id === id);
      expect(rt, `runtime ${id} registered`).toBeDefined();
      expect(rt!.capabilities.executesUntrustedTools, `${id} must be confined`).toBe(true);
    }
  });
});

describe('confinement contract: primitives deliver for flagged runtimes', () => {
  it('buildAgentChildEnv strips credentials for a flagged-runtime spawn', () => {
    const env = buildAgentChildEnv({
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/dev',
        GH_TOKEN: 'leak',
        AWS_SECRET_ACCESS_KEY: 'leak',
        OPENAI_API_KEY: 'leak',
      },
      modelProvider: 'anthropic',
      modelEnv: { ANTHROPIC_API_KEY: 'selected' },
    });
    // Zero denylisted secrets survive.
    for (const [k, v] of Object.entries(env)) {
      expect(/GH_TOKEN|AWS_SECRET|OPENAI_API_KEY/.test(k), `${k}=${v} leaked`).toBe(false);
    }
    expect(env.ANTHROPIC_API_KEY).toBe('selected');
    expect(env.HOME).toBe('/home/dev');
  });

  it('resolveConfinedCwd refuses an unconfined ($HOME) cwd', () => {
    expect(resolveConfinedCwd(homedir()).refused).toBe(true);
    expect(resolveConfinedCwd(undefined).refused).toBe(true);
  });
});
