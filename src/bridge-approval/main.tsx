import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { BridgeApprovalPrompt, BridgeApprovalWindowApi } from '../../shared/bridge-approval';
import { useThemeInjector } from '../hooks/useThemeInjector';
import '../styles/globals.css';

const api = (window as unknown as { bridgeApproval: BridgeApprovalWindowApi }).bridgeApproval;

function Approval() {
  useThemeInjector();
  const [prompt, setPrompt] = useState<BridgeApprovalPrompt>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void api
      .read()
      .then((value) => {
        document.documentElement.classList.toggle('dark', value.dark);
        setPrompt(value);
      })
      .catch(() => setError('This review is no longer available. Press Escape to close it and try again.'));
  }, []);
  const decide = (approved: boolean) => {
    if (!prompt || pending) return;
    setPending(true);
    void api.decide(prompt.id, approved).catch(() => {
      setError('This review has expired. Close it and review your selection again.');
      setPending(false);
    });
  };
  if (!prompt)
    return (
      <p role="status" className="p-6 text-sm">
        {error || 'Loading approval…'}
      </p>
    );
  return (
    <AlertDialog.Root open>
      <AlertDialog.Content
        className="flex h-dvh flex-col overflow-hidden bg-background text-foreground outline-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onEscapeKeyDown={() => decide(false)}
      >
        <header className="shrink-0 border-b border-border px-6 pb-4 pt-5">
          <AlertDialog.Title className="text-lg font-semibold leading-snug">{prompt.title}</AlertDialog.Title>
          <AlertDialog.Description className="mt-1.5 text-sm text-muted-foreground">
            Review the selected access before applying these changes.
          </AlertDialog.Description>
        </header>
        <section
          aria-label="Access details"
          tabIndex={0}
          className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-5 text-[13px] leading-relaxed [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {prompt.detail
            .split(/\n\s*\n/)
            .filter(Boolean)
            .map((block, index) => (
              <p key={index} className="whitespace-pre-wrap">
                {block}
              </p>
            ))}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </section>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-card px-6 py-4">
          <AlertDialog.Cancel asChild>
            <button
              ref={cancel}
              onClick={() => decide(false)}
              disabled={pending}
              className="min-h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Cancel
            </button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <button
              onClick={() => decide(true)}
              disabled={pending || !!error}
              className="min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Approve changes
            </button>
          </AlertDialog.Action>
        </footer>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

createRoot(document.getElementById('root')!).render(<Approval />);
