/**
 * Test stub for `@lydell/node-pty`. Replaces the real PTY with an in-memory
 * fake whose `data` and `exit` events fire on demand from test code.
 *
 * The real PTY only runs in the macOS node-pty smoke job; everything else
 * uses this stub.
 */

import { vi } from 'vitest';

export type PtyDataCallback = (data: string) => void;
export type PtyExitCallback = (info: { exitCode: number }) => void;

export interface FakePtyProcess {
  onData: (cb: PtyDataCallback) => void;
  onExit: (cb: PtyExitCallback) => void;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

export interface PtyStub {
  ptyProcess: FakePtyProcess;
  /** Drive PTY events from test code. */
  emit: {
    data(s: string): void;
    exit(code: number): void;
  };
}

export function createPtyStub(): PtyStub {
  const dataCallbacks = new Set<PtyDataCallback>();
  const exitCallbacks = new Set<PtyExitCallback>();

  const ptyProcess: FakePtyProcess = {
    onData(cb) {
      dataCallbacks.add(cb);
    },
    onExit(cb) {
      exitCallbacks.add(cb);
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      // Real PTYs emit exit on kill; preserve that behavior so consumers
      // wired up via `onExit` see something.
      for (const cb of [...exitCallbacks]) {
        cb({ exitCode: 0 });
      }
    }),
  };

  return {
    ptyProcess,
    emit: {
      data(s: string) {
        for (const cb of [...dataCallbacks]) {
          cb(s);
        }
      },
      exit(code: number) {
        for (const cb of [...exitCallbacks]) {
          cb({ exitCode: code });
        }
      },
    },
  };
}
