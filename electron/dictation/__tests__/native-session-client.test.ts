import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeStream extends EventEmitter {
  emitData(text: string): void {
    this.emit('data', Buffer.from(text));
  }
}

class FakeStdin extends EventEmitter {
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.emit('finish');
  }
}

class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStdin();
  killed = false;
  kill = vi.fn(() => {
    this.killed = true;
    return true;
  });
}

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolveCompiledHelperBinary: vi.fn(() => '/tmp/LocalMacosHelper'),
  resolveMaterializedHelperPath: vi.fn(() => '/tmp/LocalMacosHelper.swift'),
  buildSwiftFallbackEnv: vi.fn(() => ({ PATH: '/usr/bin' })),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

vi.mock('../../computer-use/permissions.js', () => ({
  resolveCompiledHelperBinary: mocks.resolveCompiledHelperBinary,
  resolveMaterializedHelperPath: mocks.resolveMaterializedHelperPath,
  buildSwiftFallbackEnv: mocks.buildSwiftFallbackEnv,
}));

describe('DictationNativeSessionClient', () => {
  let child: FakeChild;

  beforeEach(() => {
    vi.useRealTimers();
    child = new FakeChild();
    mocks.spawn.mockReset().mockReturnValue(child);
    mocks.resolveCompiledHelperBinary.mockReset().mockReturnValue('/tmp/LocalMacosHelper');
    mocks.resolveMaterializedHelperPath.mockReset().mockReturnValue('/tmp/LocalMacosHelper.swift');
    mocks.buildSwiftFallbackEnv.mockReset().mockReturnValue({ PATH: '/usr/bin' });
  });

  it('spawns the compiled helper and resolves the ready handshake', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient();

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    expect(mocks.spawn).toHaveBeenCalledWith('/tmp/LocalMacosHelper', ['dictationSession'], expect.any(Object));
  });

  it('routes request responses by id', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient();

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    const pending = client.beginSession({
      partialTyping: { ax: 'full-replacement' },
      livePartials: true,
      allowBlindKeyboardFullPatch: false,
      ownPid: 123,
      ownAppName: 'Kai',
    });
    await vi.waitFor(() => expect(child.stdin.writes.length).toBeGreaterThan(0));
    const request = JSON.parse(child.stdin.writes.at(-1) ?? '{}') as { id: string; method: string };
    expect(request.method).toBe('beginSession');

    child.stdout.emitData(`{"id":"${request.id}","ok":true,"typingMode":"ax","targetPid":456}\n`);
    await expect(pending).resolves.toMatchObject({ ok: true, typingMode: 'ax', targetPid: 456 });
  });

  it('emits target dirty events', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const onTargetDirty = vi.fn();
    const client = new DictationNativeSessionClient({ onTargetDirty });

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;
    child.stdout.emitData('{"event":"targetDirty","kind":"keyboard","eventType":"keyDown","keyCode":4}\n');

    expect(onTargetDirty).toHaveBeenCalledWith('keyboard:keyDown:4');
  });

  it('reports malformed JSON without failing the session', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const onProtocolError = vi.fn();
    const client = new DictationNativeSessionClient({ onProtocolError });

    const started = client.start();
    child.stdout.emitData('not json\n');
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining('Malformed dictation helper JSON'));
  });

  it('times out pending requests', async () => {
    vi.useFakeTimers();
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient();

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    const pending = client.applyPartial('hello');
    const expectation = expect(pending).rejects.toMatchObject({ errorCode: 'timeout' });
    await vi.advanceTimersByTimeAsync(8001);
    await expectation;
  });

  it('rejects pending requests and notifies on unexpected exit', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const onExit = vi.fn();
    const client = new DictationNativeSessionClient({ onExit });

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    const pending = client.applyPartial('hello');
    await vi.waitFor(() => expect(child.stdin.writes.length).toBeGreaterThan(0));
    child.emit('exit', 75, null);

    await expect(pending).rejects.toMatchObject({ errorCode: 'helper_exit' });
    expect(onExit).toHaveBeenCalledWith(expect.stringContaining('code 75'));
  });

  it('sends endSession during cleanup', async () => {
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient();

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    const ended = client.endSession();
    await vi.waitFor(() => expect(child.stdin.writes.length).toBeGreaterThan(0));
    const request = JSON.parse(child.stdin.writes.at(-1) ?? '{}') as { id: string; method: string };
    expect(request.method).toBe('endSession');
    child.stdout.emitData(`{"id":"${request.id}","ok":true}\n`);
    await ended;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to xcrun swift when no compiled helper exists', async () => {
    mocks.resolveCompiledHelperBinary.mockReturnValue(null as unknown as string);
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient();

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    expect(mocks.spawn).toHaveBeenCalledWith(
      'xcrun',
      ['swift', '/tmp/LocalMacosHelper.swift', 'dictationSession'],
      expect.objectContaining({ env: { PATH: '/usr/bin' } }),
    );
  });

  it('drops the stdout buffer + reports when a newline-less flood exceeds the cap', async () => {
    const onProtocolError = vi.fn();
    const { DictationNativeSessionClient } = await import('../native-session-client.js');
    const client = new DictationNativeSessionClient({ onProtocolError });

    const started = client.start();
    child.stdout.emitData('{"event":"ready","protocolVersion":1}\n');
    await started;

    // A single newline-less chunk larger than the 64 KiB cap must not accumulate.
    child.stdout.emitData('x'.repeat(70 * 1024));
    expect(onProtocolError).toHaveBeenCalledWith(expect.stringContaining('line buffer cap'));

    // The session still works afterward: a valid framed response is routed.
    child.stdout.emitData('{"event":"targetDirty","kind":"keyboard","eventType":"keyDown","keyCode":4}\n');
    // (no throw / hang — buffer was reset, parser recovered)
  });
});
