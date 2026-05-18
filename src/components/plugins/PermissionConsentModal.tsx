import { type FC, useEffect, useState, useCallback } from 'react';
import {
  ShieldAlert, FileText, Terminal, Eye, FolderOpen, XIcon, CheckIcon,
  Settings, Wrench, Layout, Bell, Globe, Lock, MessageSquare, Bot,
  Compass, Database, MonitorSmartphone, Wifi, KeyRound, PanelLeft,
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

const PERMISSION_DESCRIPTIONS: Record<string, { label: string; icon: typeof ShieldAlert; level: 'low' | 'medium' | 'high' }> = {
  // ── Elevated (dangerous) ──
  'exec:whitelisted':        { label: 'Execute whitelisted CLI commands',        icon: Terminal,          level: 'high' },
  'fs:scoped-write':         { label: 'Write files within declared directories', icon: FileText,          level: 'high' },
  'config:read-secrets':     { label: 'Read app configuration including API keys and credentials', icon: KeyRound,          level: 'high' },
  'fs:scoped-read':          { label: 'Read files within declared directories',  icon: Eye,               level: 'medium' },
  // ── Medium risk ──
  'messages:hook':           { label: 'Intercept messages before/after send',    icon: MessageSquare,     level: 'medium' },
  'network:fetch':           { label: 'Make network requests',                   icon: Globe,             level: 'medium' },
  'auth:window':             { label: 'Open authentication windows',             icon: KeyRound,          level: 'medium' },
  'http:listen':             { label: 'Listen on a local HTTP port',             icon: Wifi,              level: 'medium' },
  'safe-storage':            { label: 'Access encrypted storage',                icon: Lock,              level: 'medium' },
  'browser:window':          { label: 'Open browser windows',                    icon: MonitorSmartphone, level: 'medium' },
  'conversations:read':      { label: 'Read conversation history',               icon: MessageSquare,     level: 'medium' },
  'conversations:write':     { label: 'Modify conversations',                    icon: MessageSquare,     level: 'medium' },
  'agent:generate':          { label: 'Generate AI responses',                   icon: Bot,               level: 'medium' },
  'agent:inference-provider': { label: 'Provide custom inference backend',       icon: Bot,               level: 'medium' },
  // ── Low risk (standard) ──
  'config:read':             { label: 'Read app configuration',                  icon: Settings,          level: 'low' },
  'config:write':            { label: 'Modify app configuration',                icon: Settings,          level: 'low' },
  'tools:register':          { label: 'Register AI tools',                       icon: Wrench,            level: 'low' },
  'tools:detect':            { label: 'Detect installed CLI tools',              icon: Eye,               level: 'low' },
  'ui:banner':               { label: 'Display banners',                         icon: Layout,            level: 'low' },
  'ui:modal':                { label: 'Display modals',                          icon: Layout,            level: 'low' },
  'ui:settings':             { label: 'Register settings views',                 icon: Settings,          level: 'low' },
  'ui:panel':                { label: 'Register panels',                         icon: PanelLeft,         level: 'low' },
  'ui:navigation':           { label: 'Register navigation items',              icon: Compass,           level: 'low' },
  'notifications:send':      { label: 'Send notifications',                      icon: Bell,              level: 'low' },
  'state:publish':           { label: 'Publish plugin state',                    icon: Database,          level: 'low' },
  'navigation:open':         { label: 'Open navigation targets',                icon: Compass,           level: 'low' },
  'system:env':              { label: 'Read environment variables',              icon: Eye,               level: 'low' },
  'audit:log':               { label: 'Write to the audit log',                 icon: FileText,          level: 'low' },
};

const SCOPE_LABELS: Record<string, string> = {
  'claude-home':  '~/.claude/',
  'codex-home':   '~/.codex/',
  'plugin-own':   'Plugin directory',
  'kai-home':     '~/.kai/',
  'otc-repo':     'otc-awesome-llm repo',
};

const LEVEL_STYLES: Record<string, string> = {
  low:    'bg-blue-500/10 text-blue-600',
  medium: 'bg-yellow-500/10 text-yellow-600',
  high:   'bg-red-500/10 text-red-600',
};

export const PermissionConsentModal: FC = () => {
  const [requests, setRequests] = useState<ConsentRequest[]>([]);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    // Load any pending consent requests on mount
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any;
    if (win.app?.plugins?.getPendingConsent) {
      win.app.plugins.getPendingConsent().then((pending: ConsentRequest[]) => {
        if (pending.length > 0) setRequests(pending);
      });
    }

    // Listen for new consent requests
    if (win.app?.plugins?.onConsentRequired) {
      const unsub = win.app.plugins.onConsentRequired((data: unknown) => {
        setRequests((prev) => {
          const req = data as ConsentRequest;
          if (prev.some((r) => r.pluginName === req.pluginName)) return prev;
          return [...prev, req];
        });
      });
      return unsub;
    }
  }, []);

  const handleApprove = useCallback(async (pluginName: string) => {
    setProcessing(pluginName);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).app.plugins.approveConsent(pluginName);
      setRequests((prev) => prev.filter((r) => r.pluginName !== pluginName));
    } finally {
      setProcessing(null);
    }
  }, []);

  const handleDeny = useCallback(async (pluginName: string) => {
    setProcessing(pluginName);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).app.plugins.denyConsent(pluginName);
      setRequests((prev) => prev.filter((r) => r.pluginName !== pluginName));
    } finally {
      setProcessing(null);
    }
  }, []);

  if (requests.length === 0) return null;

  return (
    <>
      {requests.map((req) => (
        <div
          key={req.pluginName}
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50"
        >
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
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${LEVEL_STYLES[info.level]}`}>
                          {info.level}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Standard Permissions (non-dangerous) */}
              {(() => {
                const standardPerms = req.permissions.filter(
                  (p) => !req.dangerousPermissions.includes(p),
                );
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
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${LEVEL_STYLES[info.level]}`}>
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
                    {req.fsScope.directories.map((dir) => (
                      <div key={dir} className="flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">{SCOPE_LABELS[dir] ?? dir}</span>
                        <span className="text-[10px] text-muted-foreground/60 font-mono">({dir})</span>
                      </div>
                    ))}
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Operations: {req.fsScope.operations.join(', ')}
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
                      Binaries: <span className="font-mono text-foreground">{req.execScope.binaries.join(', ')}</span>
                    </div>
                    {req.execScope.argPatterns && Object.entries(req.execScope.argPatterns).map(([binary, patterns]) => (
                      <div key={binary} className="text-[10px] text-muted-foreground">
                        <span className="font-mono text-foreground">{binary}</span>: {patterns.map((p) => (
                          <code key={p} className="bg-muted px-1 rounded mx-0.5">{p}</code>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Audit Transparency */}
              <div className="rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5">
                <p className="text-[10px] text-blue-600">
                  All operations will be logged to <code className="bg-muted px-1 rounded">~/.kai/audit/plugin-operations.jsonl</code>
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2.5 border-t px-5 py-3">
              <button
                onClick={() => handleDeny(req.pluginName)}
                disabled={processing === req.pluginName}
                className="flex items-center gap-1.5 rounded-lg border px-4 py-2 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
              >
                <XIcon className="h-3.5 w-3.5" />
                Deny
              </button>
              <button
                onClick={() => handleApprove(req.pluginName)}
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
