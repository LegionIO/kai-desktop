import { z } from 'zod';

export const mcpOAuthConfigSchema = z.object({
  clientId: z.string().trim().min(1).optional(),
  clientMetadataUrl: z
    .url()
    .refine((value) => new URL(value).protocol === 'https:')
    .optional(),
  scopes: z.array(z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/)).optional(),
  callbackHost: z.enum(['127.0.0.1', 'localhost']).optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
});

export const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  oauth: mcpOAuthConfigSchema.optional(),
});
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type McpAuthReason = 'sign-in' | 'expired' | 'insufficient-scope' | 'invalid-client';
export type McpAuthStatus = {
  name: string;
  state: 'none' | 'authorized' | 'required' | 'authenticating';
  reason?: McpAuthReason;
  message?: string;
  storage: 'encrypted' | 'session';
  hasClientSecret: boolean;
  hasCredentials: boolean;
};
export type McpStatus = McpAuthStatus & {
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  error?: string;
};
export type McpLogin = { loginId: string; authorizationUrl: string; expiresAt: number };
export type McpLogout = { localCleared: true; revocation: 'confirmed' | 'unsupported' | 'failed' };
export type McpTestResult = { status: string; toolCount: number; error?: string; auth?: McpAuthStatus };
export interface McpApi {
  testConnection(server: McpServerConfig): Promise<McpTestResult>;
  getStatus(): Promise<McpStatus[]>;
  onStatusChanged(callback: (status: McpStatus[]) => void): () => void;
  login(name: string): Promise<McpLogin>;
  completeLogin(loginId: string, callbackUrl: string): Promise<void>;
  cancelLogin(name: string): Promise<void>;
  reconnect(name: string): Promise<void>;
  logout(name: string): Promise<McpLogout>;
  setClientSecret(name: string, secret: string | null): Promise<void>;
}
