import type { BridgePlugin, BridgeComponent, PluginHost } from '../../shared/plugin-bridge.js';

export type InstalledPlugin = {
  host: PluginHost;
  installation: string;
  root: string;
  version: string;
  hostEnabled: boolean | null;
  ambiguous: boolean;
};
export type McpPlan = {
  command?: string;
  args: string[];
  url?: string;
  headers: Record<string, string>;
  env: Record<string, string>;
  transport: 'stdio' | 'http' | 'sse';
  origin: string[];
};
export type HookCommand = {
  command: string;
  timeoutMs: number;
  async: boolean;
  matcher?: string;
};
export type ComponentPlan = {
  public: BridgeComponent;
  scope: string[];
  identity: string;
  mcp?: McpPlan;
  skill?: { directory: string; instructionsPath: string };
  hooks?: { event: string; commands: HookCommand[] };
};
export type PluginPlan = {
  public: BridgePlugin;
  root: string;
  dataDir: string;
  packageIdentity?: string;
  components: ComponentPlan[];
};
export type NativeBridgeSource = {
  id: string;
  name: string;
  packageIdentity?: string;
  componentIdentities?: string[];
};
