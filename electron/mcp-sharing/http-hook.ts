import type { IncomingMessage, ServerResponse } from 'node:http';

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, browserSession?: string) => boolean;
let handler: McpHttpHandler | undefined;
let close: (() => Promise<void>) | undefined;
export function setMcpHttpHandler(value: McpHttpHandler | undefined, cleanup?: () => Promise<void>): void {
  handler = value;
  close = cleanup;
}
export async function closeMcpHttpSessions(): Promise<void> {
  await close?.();
}
export function handleMcpHttp(req: IncomingMessage, res: ServerResponse, browserSession?: string): boolean {
  return handler?.(req, res, browserSession) ?? false;
}
