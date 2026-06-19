import { describe, expect, it } from 'vitest';
import { HelperProcess } from '../helper-process.js';

describe('HelperProcess', () => {
  it('routes responses by id and surfaces errors', async () => {
    const script = `
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const req = JSON.parse(line);
          if (req.cmd === 'echo') {
            process.stdout.write(JSON.stringify({ id: req.id, ok: true, data: req.args }) + '\\n');
          } else if (req.cmd === 'fail') {
            process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'boom' }) + '\\n');
          } else if (req.cmd === 'event') {
            process.stdout.write(JSON.stringify({ event: 'tick', n: 1 }) + '\\n');
            process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + '\\n');
          }
        }
      });
    `;
    const helper = new HelperProcess(process.execPath, ['-e', script], { defaultTimeoutMs: 2000 });

    try {
      const echoed = await helper.call<{ value: number }>('echo', { value: 42 });
      expect(echoed).toEqual({ value: 42 });

      await expect(helper.call('fail')).rejects.toThrow('boom');

      const events: number[] = [];
      helper.subscribe('tick', (payload) => events.push(payload.n as number));
      await helper.call('event');
      expect(events).toEqual([1]);
    } finally {
      helper.stop();
    }
  });

  it('rejects with HelperUnavailable when the process cannot spawn', async () => {
    const helper = new HelperProcess('/definitely/not/a/real/binary', []);
    await expect(helper.call('ping', undefined, 500)).rejects.toThrow();
  });

  it('times out when the helper never responds', async () => {
    const helper = new HelperProcess(process.execPath, ['-e', 'process.stdin.resume();'], {
      defaultTimeoutMs: 150,
    });
    try {
      await expect(helper.call('noop')).rejects.toThrow(/timed out/);
    } finally {
      helper.stop();
    }
  });
});
