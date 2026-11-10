import type { McpPrincipal } from './service.js';

export interface LocalMcpHandler {
  authenticate(token: string): McpPrincipal | null;
  active(principal: McpPrincipal): boolean;
  invoke(
    principal: McpPrincipal,
    sessionId: string,
    channel: string,
    args: unknown[],
    emit: (channel: string, data: unknown) => void,
  ): Promise<unknown>;
  closed(principal: McpPrincipal, sessionId: string): void;
  subscribe(listener: () => void): () => void;
}
let handler: LocalMcpHandler | undefined;
export function setLocalMcpHandler(value: LocalMcpHandler | undefined): void {
  handler = value;
}
export function getLocalMcpHandler(): LocalMcpHandler | undefined {
  return handler;
}
