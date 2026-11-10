/** Public bridge contracts. Execution plans, secrets and credential hashes stay in the backend. */
export type PluginHost = 'claude' | 'codex';
export type BridgeComponentKind = 'mcp' | 'skill' | 'hooks' | 'unsupported';
export type BridgeComponentStatus = 'off' | 'approved' | 'review-required' | 'unsupported' | 'error';
export type BridgeComponent = {
  id: string;
  name: string;
  kind: BridgeComponentKind;
  description: string;
  access: string[];
  status: BridgeComponentStatus;
  selected: boolean;
  diagnostics: string[];
  /** Opaque revision binds approval to the inventory actually reviewed. */
  revision: string;
};
export type BridgeOverlap = {
  sourceId: string;
  name: string;
  confidence: 'verified' | 'possible';
  reason: string;
  native: boolean;
  /** Only these components have verified equivalent content/configuration. */
  componentIds: string[];
};
export type BridgePlugin = {
  id: string;
  host: PluginHost;
  name: string;
  description: string;
  packagePath: string;
  version: string;
  installation: string;
  hostEnabled: boolean | null;
  ambiguous: boolean;
  selected: boolean;
  components: BridgeComponent[];
  overlaps: BridgeOverlap[];
  diagnostics: string[];
};
export type BridgeCompatibility = {
  runtime: string;
  mcp: boolean;
  skills: boolean;
  sessionHooks: boolean;
  toolHooks: 'all-kai-tools' | 'kai-tools-only';
  notes: string;
};
export type BridgeActivity = {
  id: string;
  at: string;
  kind: 'discovery' | 'approval' | 'update' | 'call' | 'error' | 'revocation';
  message: string;
  sourceId?: string;
};
export type McpExportTool = {
  id: string;
  name: string;
  description: string;
  selected: boolean;
  available: boolean;
  reason?: string;
};
export type McpExportSource = {
  id: string;
  name: string;
  selected: boolean;
  imported: boolean;
  tools: McpExportTool[];
};
export type McpSharingClient = {
  id: string;
  name: string;
  kind: 'local' | 'static' | 'oauth';
  createdAt: string;
  expiresAt: string | null;
};
export type BridgeSnapshot = {
  importsEnabled: boolean;
  sharingEnabled: boolean;
  remoteEnabled: boolean;
  publicUrl: string;
  hostHomes: Record<PluginHost, string>;
  plugins: BridgePlugin[];
  compatibility: BridgeCompatibility[];
  sources: McpExportSource[];
  clients: McpSharingClient[];
  activity: BridgeActivity[];
  remoteProblems: string[];
  credentialStorage: 'encrypted' | 'session';
};
export type BridgeMutation =
  | { action: 'imports'; enabled: boolean }
  | { action: 'homes'; claude: string; codex: string }
  | {
      action: 'approve';
      pluginId: string;
      revisions: Record<string, string>;
      allowOverlap: boolean;
      packagePath?: string;
    }
  | { action: 'sharing'; enabled: boolean }
  | { action: 'remote'; enabled: boolean; publicUrl: string }
  | { action: 'exports'; sources: string[]; tools: string[] }
  | { action: 'revoke-client'; clientId: string };
export type BridgeClientPreview = {
  id: string;
  host: PluginHost;
  path: string;
  configuration: string;
  conflict: boolean;
  expiresAt: string;
};
export interface PluginBridgeApi {
  snapshot(): Promise<BridgeSnapshot>;
  discover(): Promise<BridgeSnapshot>;
  mutate(change: BridgeMutation): Promise<BridgeSnapshot>;
  previewClient(host: PluginHost): Promise<BridgeClientPreview>;
  applyClient(previewId: string, writeConfiguration: boolean): Promise<{ configuration: string }>;
  createToken(name: string, expiresInDays: number): Promise<{ token: string; client: McpSharingClient }>;
}
