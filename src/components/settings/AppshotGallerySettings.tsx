/**
 * AppshotGallerySettings (#81) — saved-capture controls + gallery, rendered
 * inside the unified App Shots settings tab. Exported as AppshotsSettings for
 * source compatibility; new config writes use appShots.persisted.
 *
 * (File name retained to avoid a case-insensitive-filesystem collision with
 * AppShotsSettings.tsx on macOS.)
 */
import { useState, useEffect, useCallback, useRef, type FC } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { XIcon, TrashIcon, PinIcon, PaperclipIcon, ImageIcon } from 'lucide-react';
import { NumberField, Toggle, type SettingsProps } from './shared';
import { app } from '@/lib/ipc-client';
import { useAttachments } from '@/providers/AttachmentContext';
import type { Appshot } from '../../../shared/appshots';

type AppshotsConfig = {
  enabled?: boolean;
  autoCapture?: boolean;
  captureVisibleText?: boolean;
  retention?: { maxCount?: number; maxAgeDays?: number; maxTotalBytes?: number };
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip path separators / control chars / dot-components from a filename part
 *  (appName comes from OS window titles / user-writable index — untrusted). */
function sanitizeFilenamePart(raw: string, fallback = 'appshot'): string {
  const cleaned = Array.from(raw)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20 || code === 0x7f) return false; // control chars
      return ch !== '/' && ch !== '\\';
    })
    .join('')
    .replace(/\.{2,}/g, '.') // collapse runs of dots
    .replace(/^[.\s]+|[.\s]+$/g, '') // trim leading/trailing dots + spaces
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

const AppshotViewer: FC<{ appshot: Appshot; onClose: () => void; onChanged: () => void }> = ({
  appshot,
  onClose,
  onChanged,
}) => {
  const { addAttachments } = useAttachments();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  // Track pin state locally so it updates immediately after toggle without the
  // viewer holding a stale prop `appshot` (parent refreshes the list, not this).
  const [pinned, setPinned] = useState(appshot.pinned);

  useEffect(() => {
    setPinned(appshot.pinned);
  }, [appshot.pinned]);

  useEffect(() => {
    let cancelled = false;
    void app.appShots
      .getImage(appshot.id)
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appshot.id]);

  const attachToChat = useCallback(() => {
    if (!dataUrl) return;
    addAttachments([
      {
        name: `${sanitizeFilenamePart(appshot.metadata.appName ?? 'appshot')}-${appshot.id}.jpg`,
        mime: 'image/jpeg',
        isImage: true,
        size: appshot.imageBytes,
        dataUrl,
      },
    ]);
    onClose();
  }, [dataUrl, appshot, addAttachments, onClose]);

  const del = useCallback(async () => {
    try {
      await app.appShots.delete(appshot.id);
    } catch {
      /* best-effort; broadcast/refresh keeps UI consistent */
    }
    onChanged();
    onClose();
  }, [appshot.id, onChanged, onClose]);

  const togglePin = useCallback(async () => {
    const next = !pinned;
    setPinned(next); // optimistic
    try {
      await app.appShots.update(appshot.id, { pinned: next });
    } catch {
      setPinned(!next); // revert on failure
      return;
    }
    onChanged();
  }, [appshot.id, pinned, onChanged]);

  const meta = appshot.metadata;
  const rows: Array<[string, string]> = [
    ['App', meta.appName ?? '—'],
    ['Window', meta.windowTitle ?? '—'],
    ['Captured', new Date(appshot.createdAt).toLocaleString()],
    ['Size', formatBytes(appshot.imageBytes)],
    ['Conversation', appshot.conversationId ?? '—'],
    ['Trigger', meta.triggeringAction ?? '—'],
  ];

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          data-testid="appshot-viewer"
          className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[min(900px,90vw)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-card p-4 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-sm font-semibold">Appshot</Dialog.Title>
            <Dialog.Close className="rounded p-1 hover:bg-muted" aria-label="Close">
              <XIcon className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-[1fr_260px]">
            <div className="flex items-center justify-center rounded-lg border border-border/60 bg-muted/30 p-2">
              {dataUrl ? (
                <img src={dataUrl} alt="appshot" className="max-h-[60vh] w-auto rounded" />
              ) : (
                <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">Loading…</div>
              )}
            </div>
            <div className="space-y-3">
              <table className="w-full text-[11px]">
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k} className="align-top">
                      <td className="pr-2 py-0.5 text-muted-foreground">{k}</td>
                      <td className="py-0.5 break-words">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {appshot.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {appshot.tags.map((t) => (
                    <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  onClick={attachToChat}
                  disabled={!dataUrl}
                  className="flex items-center justify-center gap-2 rounded-lg border border-primary/50 bg-primary/5 px-3 py-2 text-xs disabled:opacity-50"
                >
                  <PaperclipIcon className="h-3.5 w-3.5" /> Attach to chat
                </button>
                <button
                  type="button"
                  onClick={togglePin}
                  className="flex items-center justify-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
                >
                  <PinIcon className="h-3.5 w-3.5" /> {pinned ? 'Unpin' : 'Pin'}
                </button>
                <button
                  type="button"
                  onClick={del}
                  className="flex items-center justify-center gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-xs text-red-500 dark:text-red-400"
                >
                  <TrashIcon className="h-3.5 w-3.5" /> Delete
                </button>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};

const GalleryThumb: FC<{ appshot: Appshot; onOpen: () => void }> = ({ appshot, onOpen }) => {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void app.appShots
      .getImage(appshot.id)
      .then((url) => {
        if (!cancelled) setThumb(url);
      })
      .catch(() => {
        if (!cancelled) setThumb(null);
      });
    return () => {
      cancelled = true;
    };
  }, [appshot.id]);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative aspect-video overflow-hidden rounded-lg border border-border/60 bg-muted/30"
      title={appshot.metadata.appName ?? 'appshot'}
    >
      {thumb ? (
        <img src={thumb} alt="appshot" className="h-full w-full object-cover transition group-hover:opacity-90" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      {appshot.pinned && <PinIcon className="absolute right-1 top-1 h-3 w-3 text-primary" />}
    </button>
  );
};

export const AppshotsSettings: FC<SettingsProps & { hideTitle?: boolean }> = ({ config, updateConfig, hideTitle }) => {
  const canonical = (config.appShots as { persisted?: AppshotsConfig } | undefined)?.persisted;
  const cfg = canonical ?? (config.appshots as AppshotsConfig | undefined) ?? {};
  // Write the FULL resolved object (not a single nested key) so the first
  // canonical edit of an upgraded config doesn't strand the other legacy fields:
  // once appShots.persisted exists the resolver stops consulting legacy appshots,
  // so every field must be carried over on that first write.
  const retention = {
    maxCount: cfg.retention?.maxCount ?? 200,
    maxAgeDays: cfg.retention?.maxAgeDays ?? 30,
    maxTotalBytes: cfg.retention?.maxTotalBytes ?? 524288000,
  };
  const setPersisted = (patch: Partial<AppshotsConfig>) => {
    if (canonical) {
      // Canonical object already exists: write only the changed leaf/leaves so
      // two rapid edits before a config round-trip don't clobber each other via
      // stale whole-object rebuilds.
      for (const [key, value] of Object.entries(patch)) {
        void updateConfig(`appShots.persisted.${key}`, value);
      }
      return;
    }
    // First edit of a legacy-only config: write the FULL resolved object once so
    // the other legacy fields aren't stranded when the resolver switches to the
    // canonical location.
    void updateConfig('appShots.persisted', {
      enabled: cfg.enabled ?? false,
      autoCapture: cfg.autoCapture ?? false,
      captureVisibleText: cfg.captureVisibleText ?? false,
      retention,
      ...patch,
    });
  };
  const [appshots, setAppshots] = useState<Appshot[]>([]);
  const [viewing, setViewing] = useState<Appshot | null>(null);
  // Monotonic guard: a slow older list() response must not overwrite a newer one.
  const refreshSeqRef = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++refreshSeqRef.current;
    void app.appShots
      .list()
      .then((list) => {
        if (seq === refreshSeqRef.current) setAppshots([...list].reverse()); // newest first
      })
      .catch(() => {
        /* advisory; leave the current list in place on failure */
      });
  }, []);

  useEffect(() => {
    refresh();
    const off = app.appShots.onChanged(refresh);
    return off;
  }, [refresh]);

  const deleteAll = useCallback(async () => {
    try {
      await app.appShots.deleteAll();
    } catch {
      /* best-effort */
    }
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-6">
      {!hideTitle && (
        <div>
          <h3 className="text-sm font-semibold">Saved App Shots</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Persisted, metadata-enhanced captures you can browse and re-attach into a chat.
          </p>
        </div>
      )}

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Capture</legend>
        <Toggle
          id="appShots.persisted.enabled"
          label="Enable saved App Shots"
          checked={cfg.enabled ?? false}
          onChange={(v) => setPersisted({ enabled: v })}
        />
        <Toggle
          id="appShots.persisted.autoCapture"
          label="Auto-capture frames during computer use"
          checked={cfg.autoCapture ?? false}
          onChange={(v) => setPersisted({ autoCapture: v })}
        />
        <Toggle
          id="appShots.persisted.captureVisibleText"
          label="Store visible text metadata"
          checked={cfg.captureVisibleText ?? false}
          onChange={(v) => setPersisted({ captureVisibleText: v })}
        />
        <p className="text-[10px] text-muted-foreground/80">
          Appshots are stored unencrypted under <span className="font-mono">~/.kai/data/appshots</span> (protected only
          by filesystem permissions). Full-screen excluded apps are skipped, but other visible windows may be captured.
        </p>
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Retention</legend>
        <NumberField
          id="appShots.persisted.retention.maxCount"
          label="Max appshots"
          value={cfg.retention?.maxCount ?? 200}
          onChange={(v) => setPersisted({ retention: { ...retention, maxCount: v } })}
          min={0}
          max={100000}
        />
        <NumberField
          id="appShots.persisted.retention.maxAgeDays"
          label="Max age (days)"
          value={cfg.retention?.maxAgeDays ?? 30}
          onChange={(v) => setPersisted({ retention: { ...retention, maxAgeDays: v } })}
          min={0}
          max={3650}
        />
      </fieldset>

      <fieldset className="rounded-lg border p-3 space-y-3">
        <legend className="text-xs font-semibold px-1">Gallery ({appshots.length})</legend>
        {appshots.length === 0 ? (
          <p className="text-xs text-muted-foreground">No appshots yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {appshots.map((a) => (
              <GalleryThumb key={a.id} appshot={a} onOpen={() => setViewing(a)} />
            ))}
          </div>
        )}
        {appshots.length > 0 && (
          <button
            type="button"
            onClick={deleteAll}
            className="flex items-center gap-2 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-500 dark:text-red-400"
          >
            <TrashIcon className="h-3.5 w-3.5" /> Delete all appshots
          </button>
        )}
      </fieldset>

      {viewing && <AppshotViewer appshot={viewing} onClose={() => setViewing(null)} onChanged={refresh} />}
    </div>
  );
};
