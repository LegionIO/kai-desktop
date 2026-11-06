import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { app } from '@/lib/ipc-client';
import { isWebBridgeRuntime } from '@/lib/media-url';
import type { McpLogin, McpStatus } from '../../../shared/mcp';

export function useMcpStatus(): McpStatus[] {
  const [statuses, setStatuses] = useState<McpStatus[]>([]);
  useEffect(() => {
    if (!app.mcp?.getStatus || !app.mcp?.onStatusChanged) return;
    let alive = true,
      receivedEvent = false;
    const off = app.mcp.onStatusChanged((next) => {
      receivedEvent = true;
      if (alive) setStatuses(next);
    });
    void app.mcp
      .getStatus()
      .then((next) => {
        if (alive && !receivedEvent) setStatuses(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return statuses;
}

const buttonClass =
  'rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

export function McpAuthControls({ name, status, clientId }: { name: string; status?: McpStatus; clientId?: string }) {
  const isWeb = isWebBridgeRuntime();
  const [login, setLogin] = useState<McpLogin | null>(null);
  const [open, setOpen] = useState(false);
  const [callback, setCallback] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [secretOpen, setSecretOpen] = useState(false);
  const [secret, setSecret] = useState('');
  useEffect(() => {
    if (status?.state === 'authorized') {
      setOpen(false);
      setLogin(null);
      setCallback('');
    }
    if (status?.state === 'required') {
      setOpen(false);
      setLogin(null);
      setCallback('');
    }
  }, [status?.state]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The request failed. Try again.');
    } finally {
      setBusy(false);
    }
  };
  const start = () =>
    run(async () => {
      const flow = await app.mcp.login(name);
      setLogin(flow);
      setOpen(true);
      if (isWeb) window.open(flow.authorizationUrl, '_blank', 'noopener,noreferrer');
      else await app.mcp.openLogin(flow.loginId, 'in-app');
    });
  const close = () => {
    setOpen(false);
    setCallback('');
    setLogin(null);
    void run(() => app.mcp.cancelLogin(name));
  };

  return (
    <div className="space-y-2 text-xs">
      {status?.message && <p className="break-words text-muted-foreground">{status.message}</p>}
      {status?.storage === 'session' && (
        <p className="text-muted-foreground">
          Credentials last for this Kai session only. OS secure storage is unavailable.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {status?.state !== 'authorized' && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy || status?.enabled === false}
            onClick={() => void start()}
          >
            {busy
              ? 'Please wait…'
              : status?.state === 'authenticating'
                ? 'Continue sign-in'
                : status?.reason && status.reason !== 'sign-in'
                  ? 'Reconnect'
                  : 'Sign in'}
          </button>
        )}
        {status?.state === 'authenticating' && (
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void run(() => app.mcp.cancelLogin(name))}
          >
            Cancel
          </button>
        )}
        {status?.state === 'authorized' && (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void run(() => app.mcp.reconnect(name))}
            >
              Reconnect
            </button>
          </>
        )}
        {(status?.hasCredentials || status?.state === 'authorized') && (
          <>
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await app.mcp.logout(name);
                  setMessage(
                    result.revocation === 'confirmed'
                      ? 'Signed out. Server revocation confirmed.'
                      : 'Signed out locally. Server revocation was not confirmed.',
                  );
                })
              }
            >
              Sign out
            </button>
          </>
        )}
        {clientId && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setSecret('');
              setSecretOpen(true);
            }}
          >
            {status?.hasClientSecret ? 'Replace client secret' : 'Set client secret'}
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="break-words">
          {message}
        </p>
      )}
      <Dialog.Root
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-y-auto max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-6">
            <Dialog.Title className="pr-8 text-lg font-semibold break-words">Sign in to {name}</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              {isWeb
                ? 'Finish signing in in your browser. Kai will reconnect when you return.'
                : 'Finish signing in in the Kai sign-in window. If your provider requires an external browser, use Open in system browser.'}
            </Dialog.Description>
            <Dialog.Close className="absolute right-4 top-4 rounded p-1 hover:bg-muted" aria-label="Cancel sign-in">
              <XIcon className="h-4 w-4" />
            </Dialog.Close>
            {login && isWeb && (
              <a
                href={login.authorizationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-4 inline-block text-sm underline underline-offset-4"
              >
                Open sign-in page
              </a>
            )}
            {login && !isWeb && (
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void run(() => app.mcp.openLogin(login.loginId, 'in-app'))}
                >
                  Show sign-in window
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => void run(() => app.mcp.openLogin(login.loginId, 'system'))}
                >
                  Open in system browser
                </button>
              </div>
            )}
            {message && (
              <p role="status" className="mt-3 break-words text-sm">
                {message}
              </p>
            )}
            <form
              className="mt-5 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (login)
                  void run(async () => {
                    await app.mcp.completeLogin(login.loginId, callback.trim());
                    setCallback('');
                    setOpen(false);
                  });
              }}
            >
              <label className="block text-sm">
                If the browser cannot return to Kai, paste the full callback URL
                <input
                  aria-label="Callback URL"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-base"
                />
              </label>
              {message && (
                <p role="alert" className="text-sm text-destructive break-words">
                  {message}
                </p>
              )}
              {!login && (
                <p className="text-sm">{status?.message ?? 'This sign-in ended. Close this dialog and try again.'}</p>
              )}
              <button type="submit" className={buttonClass} disabled={busy || !callback.trim() || !login}>
                Complete sign-in
              </button>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={secretOpen}
        onOpenChange={(value) => {
          setSecretOpen(value);
          if (!value) setSecret('');
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/50" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[101] w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] overflow-y-auto max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-6">
            <Dialog.Title className="text-lg font-semibold">Client secret</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              Only enter a secret if your registered OAuth client requires one. It stays in Kai’s credential store.
            </Dialog.Description>
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await app.mcp.setClientSecret(name, secret);
                  setSecret('');
                  setSecretOpen(false);
                });
              }}
            >
              <input
                aria-label="Client secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-base"
              />
              {message && (
                <p role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button className={buttonClass} type="submit" disabled={busy || !secret}>
                  Save secret
                </button>
                {status?.hasClientSecret && (
                  <button
                    className={buttonClass}
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await app.mcp.setClientSecret(name, null);
                        setSecretOpen(false);
                        setSecret('');
                      })
                    }
                  >
                    Remove secret
                  </button>
                )}
                <Dialog.Close className={buttonClass}>Cancel</Dialog.Close>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export function McpAuthNotice() {
  const statuses = useMcpStatus();
  const pending = statuses.filter((status) => status.enabled && ['required', 'authenticating'].includes(status.state));
  if (!pending.length) return null;
  return (
    <aside
      aria-label="MCP sign-in required"
      className="relative z-30 max-h-56 shrink-0 overflow-y-auto border-b bg-background px-4 py-3"
    >
      <div className="space-y-3">
        {pending.map((status) => (
          <div key={status.name} className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <span className="min-w-0 break-words text-sm font-medium">{status.name}</span>
            <McpAuthControls name={status.name} status={status} />
          </div>
        ))}
      </div>
    </aside>
  );
}
