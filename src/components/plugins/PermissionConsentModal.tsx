import { type FC, useEffect, useState, useCallback } from 'react';
import {
  ShieldAlert,
  FileText,
  Terminal,
  Eye,
  FolderOpen,
  XIcon,
  CheckIcon,
  Settings,
  Wrench,
  Layout,
  Bell,
  Globe,
  Lock,
  MessageSquare,
  Bot,
  Compass,
  Database,
  MonitorSmartphone,
  Wifi,
  KeyRound,
  PanelLeft,
  SquareKanban,
} from 'lucide-react';

type ConsentRequest = {
  pluginName: string;
  displayName: string;
  permissions: string[];
  dangerousPermissions: string[];
  fsScope?: {
    directories: string[];
    operations: string[];
  };
  execScope?: {
    binaries: string[];
    argPatterns?: Record<string, string[]>;
  };
  fileHash: string;
};

const PERMISSION_DESCRIPTIONS: Record<
  string,
  { label: string; icon: typeof ShieldAlert; level: 'low' | 'medium' | 'high' }
> = {
  // ── Elevated (dangerous) ──
  'exec:whitelisted': { label: 'Execute whitelisted CLI commands', icon: Terminal, level: 'high' },
  'fs:scoped-write': { label: 'Write files within declared directories', icon: FileText, level: 'high' },
  'config:read-secrets': {
    label: 'Read app configuration including API keys and credentials',
    icon: KeyRound,
    level: 'high',
  },
  'agent:hook': {
    label: 'Observe, block, or rewrite prompts, tool calls, and tool results',
    icon: Bot,
    level: 'high',
  },
  'http:listen:network': {
    label: 'Expose its local HTTP server to other devices on your network',
    icon: Wifi,
    level: 'high',
  },
  'tasks:write': { label: 'Create, edit, and archive tasks', icon: SquareKanban, level: 'high' },
  'browser:authenticated-session': {
    label:
      'Run trusted plugin interface code that can access Kai desktop data and API keys and inspect or control authenticated Browser pages; a plugin-provided AI backend may also control those pages',
    icon: MonitorSmartphone,
    level: 'high',
  },
  'fs:scoped-read': { label: 'Read files within declared directories', icon: Eye, level: 'medium' },
  // ── Medium risk ──
  'messages:hook': { label: 'Intercept messages before/after send', icon: MessageSquare, level: 'medium' },
  'network:fetch': { label: 'Make network requests', icon: Globe, level: 'medium' },
  'auth:window': { label: 'Open authentication windows', icon: KeyRound, level: 'medium' },
  'http:listen': { label: 'Listen on a local HTTP port', icon: Wifi, level: 'medium' },
  'safe-storage': { label: 'Access encrypted storage', icon: Lock, level: 'medium' },
  'browser:window': { label: 'Open browser windows', icon: MonitorSmartphone, level: 'medium' },
  'conversations:read': { label: 'Read conversation history', icon: MessageSquare, level: 'medium' },
  'conversations:write': { label: 'Modify conversations', icon: MessageSquare, level: 'medium' },
  'tasks:read': { label: 'Read tasks and subscribe to board changes', icon: SquareKanban, level: 'medium' },
  'agent:generate': { label: 'Generate AI responses', icon: Bot, level: 'medium' },
  'agent:inference-provider': { label: 'Provide custom inference backend', icon: Bot, level: 'medium' },
  // ── Low risk (standard) ──
  'config:read': { label: 'Read app configuration', icon: Settings, level: 'low' },
  'config:write': { label: 'Modify app configuration', icon: Settings, level: 'low' },
  'tools:register': { label: 'Register AI tools', icon: Wrench, level: 'low' },
  'tools:detect': { label: 'Detect installed CLI tools', icon: Eye, level: 'low' },
  'ui:banner': { label: 'Display banners', icon: Layout, level: 'low' },
  'ui:modal': { label: 'Display modals', icon: Layout, level: 'low' },
  'ui:settings': { label: 'Register settings views', icon: Settings, level: 'low' },
  'ui:panel': { label: 'Register panels', icon: PanelLeft, level: 'low' },
  'ui:navigation': { label: 'Register navigation items', icon: Compass, level: 'low' },
  'notifications:send': { label: 'Send notifications', icon: Bell, level: 'low' },
  'state:publish': { label: 'Publish plugin state', icon: Database, level: 'low' },
  'events:publish': { label: 'Publish automation events', icon: Bell, level: 'low' },
  'events:subscribe': { label: 'Subscribe to automation events', icon: Bell, level: 'low' },
  'navigation:open': { label: 'Open navigation targets', icon: Compass, level: 'low' },
  'system:env': { label: 'Read environment variables', icon: Eye, level: 'low' },
  'audit:log': { label: 'Write to the audit log', icon: FileText, level: 'low' },
};

const SCOPE_LABELS: Record<string, string> = {
  'claude-home': '~/.claude/',
  'codex-home': '~/.codex/',
  'plugin-own': 'Plugin directory',
  'kai-home': '~/.kai/',
  'otc-repo': 'otc-awesome-llm repo',
};

const LEVEL_STYLES: Record<string, string> = {
  low: 'bg-blue-500/10 text-blue-600',
  medium: 'bg-yellow-500/10 text-yellow-600',
  high: 'bg-red-500/10 text-red-600',
};

function normalizeConsentRequest(data: unknown): ConsentRequest | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Partial<ConsentRequest> & { pluginName?: string };
  if (!raw.pluginName) return null;
  return {
    pluginName: raw.pluginName,
    displayName: raw.displayName ?? raw.pluginName,
    permissions: Array.isArray(raw.permissions) ? raw.permissions : [],
    dangerousPermissions: Array.isArray(raw.dangerousPermissions) ? raw.dangerousPermissions : [],
    fsScope: raw.fsScope,
    execScope: raw.execScope,
    fileHash: raw.fileHash ?? '',
  };
}

export const PermissionConsentModal: FC = () => {
  const [requests, setRequests] = useState<ConsentRequest[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);
  // Error surfaced when approve/deny returns { success:false, error } (e.g. an
  // app-update freeze rejects consent resolution) — R42P2. Keyed by GENERATION
  // (pluginName + fileHash), NOT plugin name alone (R44P3): if a stale H1 decision
  // fails and resync replaces the prompt with a same-name H2, H2 must not display
  // H1's error — a different generation the user never acted on.
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const errorKey = (pluginName: string, fileHash: string) => `${pluginName}:${fileHash}`;

  useEffect(() => {
    // Load any pending consent requests on mount
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    if (win.app?.plugins?.getPendingConsent) {
      win.app.plugins.getPendingConsent().then((pending: unknown[]) => {
        const normalized = (Array.isArray(pending) ? pending : [])
          .map(normalizeConsentRequest)
          .filter((r): r is ConsentRequest => r !== null);
        if (normalized.length > 0) setRequests(normalized);
      });
    }

    // Listen for new consent requests
    if (win.app?.plugins?.onConsentRequired) {
      const unsub = win.app.plugins.onConsentRequired((data: unknown) => {
        const req = normalizeConsentRequest(data);
        if (!req) return;
        setRequests((prev) => {
          const existing = prev.find((r) => r.pluginName === req.pluginName);
          // Same name AND same hash → already showing this exact request; no-op.
          if (existing && existing.fileHash === req.fileHash) return prev;
          // Same name but a DIFFERENT hash → a new generation (H2) replaced H1
          // (rollback/reinstall). REPLACE the stale prompt so the user sees H2's
          // actual permissions, not H1's (R29P1). Otherwise a by-name dedup would
          // keep showing H1 while main holds H2.
          if (existing) return prev.map((r) => (r.pluginName === req.pluginName ? req : r));
          return [...prev, req];
        });
      });
      return unsub;
    }
  }, []);

  // After a consent decision (approve OR deny) that main reports as taken-effect,
  // RE-SYNC the prompt list from main's authoritative pending set rather than
  // optimistically filtering by name (R28P52/R28P56/R29P1): a rollback/reload can
  // re-create a same-name request, and a stale cross-request decision can be
  // REJECTED leaving the live request pending — in both cases a by-name drop would
  // hide a request main still holds, invisibly blocking future update freezes. On
  // re-sync FAILURE, KEEP the current prompt (safer than hiding a live request).
  const resyncPendingConsent = useCallback(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pending = (await (window as any).app.plugins.getPendingConsent()) as unknown[];
    const normalized = (Array.isArray(pending) ? pending : [])
      .map(normalizeConsentRequest)
      .filter((r): r is ConsentRequest => r !== null);
    setRequests(normalized);
  }, []);

  const handleApprove = useCallback(
    async (pluginName: string, fileHash: string) => {
      setProcessing(pluginName);
      const key = errorKey(pluginName, fileHash);
      // Clear any prior error for THIS generation before retrying.
      setActionErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        // Pass the fileHash the user was shown so main can reject a STALE cross-request
        // decision (a different generation now holding the prompt) (R28P55).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await (window as any).app.plugins.approveConsent(pluginName, fileHash)) as
          | { success?: boolean; error?: string }
          | undefined;
        // Surface a structured rejection (e.g. an app-update freeze) so the user
        // understands why the button did nothing, rather than it appearing
        // ineffective (R42P2). The request stays pending and is retryable. Keyed by
        // generation so a same-name replacement (H2) doesn't inherit this error (R44P3).
        if (result && result.success === false) {
          setActionErrors((prev) => ({
            ...prev,
            [key]: result.error || 'Could not approve the plugin right now. Please try again in a moment.',
          }));
        }
        // ALWAYS re-sync from main afterwards — on success OR on a { success:false }
        // stale-rejection (R29P2): if we skipped resync on false, a rejected approval
        // (client held H1, main now holds H2) would leave the stale H1 modal up, and
        // every retry re-sends the same stale hash and fails — permanently stuck.
        // Resyncing surfaces the LIVE request (H2) the user can actually act on. Keep
        // the current prompt only if the resync itself fails (R28P56).
        try {
          await resyncPendingConsent();
        } catch {
          /* resync failed → keep current prompt */
        }
      } finally {
        setProcessing(null);
      }
    },
    [resyncPendingConsent],
  );

  const handleDeny = useCallback(
    async (pluginName: string, fileHash: string) => {
      setProcessing(pluginName);
      const key = errorKey(pluginName, fileHash);
      setActionErrors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (await (window as any).app.plugins.denyConsent(pluginName, fileHash)) as
          | { success?: boolean; error?: string }
          | undefined;
        // Surface a structured rejection (e.g. an app-update freeze) — the request
        // stays pending and is retryable (R42P2). Generation-keyed (R44P3).
        if (result && result.success === false) {
          setActionErrors((prev) => ({
            ...prev,
            [key]: result.error || 'Could not deny the plugin right now. Please try again in a moment.',
          }));
        }
        // ALWAYS re-sync from main afterwards (R28P52/R29P2). On success a rollback
        // may have re-created a same-name request; on a { success:false } freeze
        // refusal the same request is still pending — resync re-shows the authoritative
        // set either way. Keep the current prompt only if resync itself fails (R28P56).
        try {
          await resyncPendingConsent();
        } catch {
          /* resync failed → keep current prompt */
        }
      } finally {
        setProcessing(null);
      }
    },
    [resyncPendingConsent],
  );

  if (requests.length === 0) return null;

  return (
    <>
      {requests.map((req) => (
        <div key={req.pluginName} className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50">
          <div className="relative w-full max-w-lg rounded-xl border bg-card shadow-2xl mx-4">
            {/* Header */}
            <div className="flex items-center gap-3 border-b px-5 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-yellow-500/10">
                <ShieldAlert className="h-5 w-5 text-yellow-600" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">Permission Required</h2>
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{req.displayName}</span>{' '}
                  {req.dangerousPermissions.length > 0
                    ? 'requests elevated permissions'
                    : 'requests the following permissions'}
                </p>
              </div>
            </div>

            {/* Body */}
            <div className="space-y-4 px-5 py-4 max-h-[60vh] overflow-y-auto">
              {/* Elevated Permissions (dangerous) */}
              {req.dangerousPermissions.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">Elevated Permissions</h3>
                  {req.dangerousPermissions.map((perm) => {
                    const info = PERMISSION_DESCRIPTIONS[perm];
                    if (!info) return null;
                    const Icon = info.icon;
                    return (
                      <div key={perm} className="flex items-center gap-2.5 rounded-md border p-2.5">
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-medium text-foreground">{info.label}</span>
                          <span className="ml-2 text-[10px] text-muted-foreground font-mono">{perm}</span>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${LEVEL_STYLES[info.level]}`}
                        >
                          {info.level}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Standard Permissions (non-dangerous) */}
              {(() => {
                const standardPerms = req.permissions.filter((p) => !req.dangerousPermissions.includes(p));
                if (standardPerms.length === 0) return null;
                return (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-foreground">
                      {req.dangerousPermissions.length > 0 ? 'Standard Permissions' : 'Requested Permissions'}
                    </h3>
                    <div className="rounded-md border divide-y">
                      {standardPerms.map((perm) => {
                        const info = PERMISSION_DESCRIPTIONS[perm];
                        if (!info) {
                          return (
                            <div key={perm} className="flex items-center gap-2.5 px-2.5 py-2">
                              <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="text-xs text-muted-foreground font-mono">{perm}</span>
                            </div>
                          );
                        }
                        const Icon = info.icon;
                        return (
                          <div key={perm} className="flex items-center gap-2.5 px-2.5 py-2">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <span className="text-xs text-foreground">{info.label}</span>
                            </div>
                            <span
                              className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${LEVEL_STYLES[info.level]}`}
                            >
                              {info.level}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Filesystem Scope */}
              {req.fsScope && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <FolderOpen className="h-3.5 w-3.5" /> Directory Access
                  </h3>
                  <div className="rounded-md border p-2.5 space-y-1">
                    {(req.fsScope.directories ?? []).map((dir) => (
                      <div key={dir} className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">{SCOPE_LABELS[dir] ?? dir}</span>
                        <span className="text-[10px] text-muted-foreground/60 font-mono">({dir})</span>
                      </div>
                    ))}
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Operations: {(req.fsScope.operations ?? []).join(', ')}
                    </div>
                  </div>
                </div>
              )}

              {/* Exec Scope */}
              {req.execScope && (
                <div className="space-y-1.5">
                  <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Terminal className="h-3.5 w-3.5" /> Command Execution
                  </h3>
                  <div className="rounded-md border p-2.5 space-y-1">
                    <div className="text-xs text-muted-foreground">
                      Binaries:{' '}
                      <span className="font-mono text-foreground">{(req.execScope.binaries ?? []).join(', ')}</span>
                    </div>
                    {req.execScope.argPatterns &&
                      Object.entries(req.execScope.argPatterns).map(([binary, patterns]) => (
                        <div key={binary} className="text-[10px] text-muted-foreground">
                          <span className="font-mono text-foreground">{binary}</span>:{' '}
                          {patterns.map((p) => (
                            <code key={p} className="bg-muted px-1 rounded mx-0.5">
                              {p}
                            </code>
                          ))}
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Audit Transparency */}
              <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5">
                <p className="text-[10px] text-blue-600">
                  All operations will be logged to{' '}
                  <code className="bg-muted px-1 rounded">~/.kai/audit/plugin-operations.jsonl</code>
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2.5 border-t px-5 py-3">
              {actionErrors[errorKey(req.pluginName, req.fileHash)] && (
                <p className="mr-auto text-[11px] text-red-600" role="alert">
                  {actionErrors[errorKey(req.pluginName, req.fileHash)]}
                </p>
              )}
              <button
                onClick={() => handleDeny(req.pluginName, req.fileHash)}
                disabled={processing === req.pluginName}
                className="flex items-center gap-1.5 rounded-lg border px-4 py-2 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <XIcon className="h-3.5 w-3.5" />
                Deny
              </button>
              <button
                onClick={() => handleApprove(req.pluginName, req.fileHash)}
                disabled={processing === req.pluginName}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                <CheckIcon className="h-3.5 w-3.5" />
                {processing === req.pluginName ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      ))}
    </>
  );
};
