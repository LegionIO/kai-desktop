import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** MCP framing from the SDK, with ownership of the entire process group. */
export class OwnedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private readonly buffer = new ReadBuffer();
  private partialBytes = 0;
  private closed = false;
  constructor(
    private readonly options: { command: string; args: string[]; cwd: string; env: Record<string, string> },
  ) {}
  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error('MCP transport already started or closed.');
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.on('data', () => {}); // Drain, but never log plugin secrets.
    child.stdin.on('error', () => this.fail());
    child.stdout.on('data', (chunk: Buffer) => {
      this.partialBytes += chunk.length;
      if (this.partialBytes > 16 * 1024 * 1024) {
        this.fail();
        return;
      }
      this.buffer.append(chunk);
      try {
        let message: JSONRPCMessage | null;
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message);
        const newline = chunk.lastIndexOf(10);
        if (newline >= 0) this.partialBytes = chunk.length - newline - 1;
      } catch {
        this.fail();
      }
    });
    child.on('close', () => {
      this.kill();
      this.finish();
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', () => {
        this.fail();
        reject(new Error('Imported MCP process could not start.'));
      });
    });
  }
  private fail(): void {
    if (this.closed) return;
    this.onerror?.(new Error('Imported MCP process or message failed.'));
    void this.close();
  }
  private kill(): void {
    try {
      if (process.platform !== 'win32' && this.child?.pid) process.kill(-this.child.pid, 'SIGKILL');
      else this.child?.kill('SIGKILL');
    } catch {
      /* Process group already exited. */
    }
  }
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer.clear();
    this.onclose?.();
  }
  async close(): Promise<void> {
    this.kill();
    this.child?.stdin.destroy();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.finish();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child) throw new Error('Imported MCP transport is closed.');
    const serialized = serializeMessage(message);
    if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('MCP request exceeds the size limit.');
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.write(serialized, (error) => (error ? reject(error) : resolve())),
    );
  }
}
