import { useState, type FC } from 'react';
import { Copy, RefreshCw, Check } from 'lucide-react';
import { Toggle, NumberField, TextField, settingsSelectClass, type SettingsProps } from './shared';
import { WebServerQRCode } from './WebServerQRCode';

/** Generate a ~16-char URL-safe random password in the renderer (no Node APIs). */
function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type WebServerConfig = {
  enabled: boolean;
  port: number;
  bindAddress: string;
  tls: {
    enabled: boolean;
    mode: 'self-signed' | 'custom';
    certPath: string;
    keyPath: string;
  };
  auth: {
    mode: 'anonymous' | 'password';
    username: string;
    password: string;
  };
};

export const WebServerSettings: FC<SettingsProps> = ({ config, updateConfig }) => {
  const ws = (config.webServer as WebServerConfig | undefined) ?? {
    enabled: false,
    port: 5243,
    bindAddress: '0.0.0.0',
    tls: { enabled: true, mode: 'self-signed' as const, certPath: '', keyPath: '' },
    auth: { mode: 'password' as const, username: 'kai', password: '' },
  };

  const [showQR, setShowQR] = useState(false);
  const [copied, setCopied] = useState(false);
  const protocol = ws.tls.enabled ? 'https' : 'http';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Web UI</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Serve the same chat interface over HTTP/HTTPS so you can access it from any browser on your network.
        </p>
      </div>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Server</legend>
        <Toggle
          id="webServer.enabled"
          label="Enable Web UI server"
          checked={ws.enabled}
          onChange={(v) => updateConfig('webServer.enabled', v)}
        />

        {ws.enabled && (
          <>
            <NumberField
              id="webServer.port"
              label="Port"
              value={ws.port}
              onChange={(v) => {
                if (v >= 1 && v <= 65535) updateConfig('webServer.port', v);
              }}
              min={1}
              max={65535}
            />
            <TextField
              id="webServer.bindAddress"
              label="Bind Address"
              value={ws.bindAddress ?? '0.0.0.0'}
              onChange={(v) => updateConfig('webServer.bindAddress', v)}
              placeholder="0.0.0.0"
              mono
            />
            <p className="text-[10px] text-muted-foreground">
              Access the Web UI at{' '}
              <span className="font-mono">
                {protocol}://{['0.0.0.0', '::', ''].includes(ws.bindAddress) ? 'localhost' : ws.bindAddress}:{ws.port}
              </span>
            </p>
          </>
        )}
      </fieldset>

      {ws.enabled && (
        <>
          <fieldset className="rounded-lg border p-3 space-y-3">
            <legend className="text-xs font-semibold px-1">TLS / HTTPS</legend>
            <Toggle
              id="webServer.tls.enabled"
              label="Enable HTTPS"
              checked={ws.tls.enabled}
              onChange={(v) => updateConfig('webServer.tls.enabled', v)}
            />
            <p className="text-[10px] text-muted-foreground">
              HTTPS is required for microphone access (voice recording, realtime calls) when connecting from other
              devices.
            </p>

            {ws.tls.enabled && (
              <div className="space-y-3 pl-1">
                <div data-setting-id="webServer.tls.mode">
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Certificate Mode</label>
                  <select
                    className={settingsSelectClass}
                    value={ws.tls.mode}
                    onChange={(e) => updateConfig('webServer.tls.mode', e.target.value)}
                  >
                    <option value="self-signed">Self-Signed (auto-generated)</option>
                    <option value="custom">Custom Certificate</option>
                  </select>
                </div>

                {ws.tls.mode === 'self-signed' && (
                  <p className="text-[10px] text-muted-foreground">
                    A self-signed certificate will be generated automatically for localhost and all local network IPs.
                    Your browser will show a security warning on first visit — accept it to proceed.
                  </p>
                )}

                {ws.tls.mode === 'custom' && (
                  <div className="space-y-3">
                    <TextField
                      label="Certificate file path"
                      value={ws.tls.certPath}
                      onChange={(v) => updateConfig('webServer.tls.certPath', v)}
                      placeholder="/path/to/cert.pem"
                      mono
                    />
                    <TextField
                      label="Private key file path"
                      value={ws.tls.keyPath}
                      onChange={(v) => updateConfig('webServer.tls.keyPath', v)}
                      placeholder="/path/to/key.pem"
                      mono
                    />
                  </div>
                )}
              </div>
            )}
          </fieldset>

          <fieldset className="rounded-lg border p-3 space-y-3">
            <legend className="text-xs font-semibold px-1">Authentication</legend>
            <div data-setting-id="webServer.auth.mode">
              <label className="text-[10px] text-muted-foreground block mb-0.5">Access Mode</label>
              <select
                className={settingsSelectClass}
                value={ws.auth.mode}
                onChange={(e) => updateConfig('webServer.auth.mode', e.target.value)}
              >
                <option value="password">Password Protected</option>
                <option value="anonymous">Anonymous (no login required)</option>
              </select>
            </div>

            {ws.auth.mode === 'anonymous' && (
              <p className="text-[10px] text-amber-600 dark:text-amber-500 pl-1">
                Anyone on your network will have full access. Only use on trusted networks.
              </p>
            )}

            {ws.auth.mode === 'password' && (
              <div className="space-y-3 pl-1">
                <TextField
                  label="Username"
                  value={ws.auth.username}
                  onChange={(v) => updateConfig('webServer.auth.username', v)}
                  placeholder="kai"
                />
                <div data-setting-id="webServer.auth.password">
                  <label className="text-[10px] text-muted-foreground block mb-0.5">Password</label>
                  <div className="flex gap-1.5">
                    <input
                      className="flex-1 rounded-md border border-border/60 bg-card/60 px-2 py-1 text-xs font-mono"
                      value={ws.auth.password}
                      onChange={(e) => updateConfig('webServer.auth.password', e.target.value)}
                      placeholder="(auto-generated on first enable)"
                    />
                    <button
                      type="button"
                      title="Copy password"
                      className="rounded-md border border-border/60 bg-card/60 px-2 hover:bg-card transition-colors"
                      onClick={() => {
                        void window.app?.clipboard.writeText(ws.auth.password);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      }}
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      title="Regenerate password"
                      className="rounded-md border border-border/60 bg-card/60 px-2 hover:bg-card transition-colors"
                      onClick={() => updateConfig('webServer.auth.password', generatePassword())}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </fieldset>

          <fieldset className="rounded-lg border p-3 space-y-3">
            <legend className="text-xs font-semibold px-1">Remote Access</legend>
            <p className="text-[10px] text-muted-foreground">
              Scan the QR code from a phone or tablet to open the web UI with auto-login.
            </p>

            <button
              className="w-full rounded-xl border border-border/60 bg-card/60 px-3 py-2 text-xs hover:bg-card transition-colors"
              onClick={() => setShowQR(true)}
            >
              Show QR Code
            </button>
          </fieldset>
        </>
      )}

      {showQR && <WebServerQRCode config={ws} onClose={() => setShowQR(false)} />}
    </div>
  );
};
