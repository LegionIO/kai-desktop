import { useCallback, useEffect } from 'react';
import { parseAppShotRef, type AppShotPayload } from '../../shared/app-shots';
import { app } from '@/lib/ipc-client';
import { useAttachments, type AttachedFile } from '@/providers/AttachmentContext';
import { useMidTurnComposer } from '@/providers/RuntimeProvider';
import { filterAttachmentsBySize, releaseAttachmentReservation } from '@/lib/attachment-limits';

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function appShotPayloadToAttachments(payload: AppShotPayload): AttachedFile[] {
  const imageMime = payload.imageDataUrl.slice(5, payload.imageDataUrl.indexOf(';')) || 'image/png';
  const ext = MIME_EXTENSIONS[imageMime] ?? imageMime.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'png';
  const metaBytes = new TextEncoder().encode(payload.metaJson).length;
  return [
    {
      name: `${payload.suggestedName}.${ext}`,
      mime: imageMime,
      isImage: true,
      size: payload.imageBytes,
      dataUrl: payload.imageDataUrl,
    },
    {
      name: `${payload.suggestedName}.appshot.json`,
      mime: 'application/json',
      isImage: false,
      size: metaBytes,
      dataUrl: `data:application/json;base64,${toBase64(payload.metaJson)}`,
      text: payload.metaJson,
    },
  ];
}

/**
 * Subscribes to App Shot captures from the main process and injects each one
 * into the chat composer as two attachments: the screenshot image and a JSON
 * sidecar containing the window metadata / UI tree / selected text.
 *
 * Mount once inside the AttachmentProvider subtree (e.g. at the App root).
 */
export function useAppShots(): void {
  const { addAttachments } = useAttachments();

  useEffect(() => {
    return app.appShots.onCaptured((payload: AppShotPayload & { autoAttach?: boolean }) => {
      if (payload.autoAttach) {
        addAttachments(appShotPayloadToAttachments(payload));
      }
    });
  }, [addAttachments]);
}

/**
 * Composer paste hook: inspects clipboard text/HTML for a `[kai-appshot:<ref>]`
 * marker, resolves it via IPC, and attaches the image + metadata sidecar.
 * Returns `true` when the paste was an App Shot and was fully handled.
 */
export function useAppShotPasteHandler(): (event: React.ClipboardEvent<HTMLElement>) => boolean {
  const { addAttachments, getResidentBytes } = useAttachments();
  const { getActiveConversationId } = useMidTurnComposer();

  return useCallback(
    (event) => {
      const text = event.clipboardData.getData('text/plain') || '';
      const html = event.clipboardData.getData('text/html') || '';
      const refId =
        parseAppShotRef(text) ?? html.match(/kai-appshot-ref"\s+content="([A-Za-z0-9_-]{6,64})"/)?.[1] ?? null;

      if (!refId) return false;

      // Capture clipboard image items synchronously so we can still attach the
      // raw screenshot if the ref turns out to be stale (restart / eviction /
      // copied from another machine).
      const imageFiles: File[] = [];
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      event.preventDefault();
      // Bind to the originating conversation (R187): resolveRef + the fallback FileReaders are async and
      // write to the app-global attachment store, so a chat switch mid-await would otherwise attach the
      // screenshot + metadata to the wrong chat.
      const originConversationId = getActiveConversationId();
      void app.appShots.resolveRef(refId).then((payload) => {
        if (getActiveConversationId() !== originConversationId) return;
        if (payload) {
          // Surface a partial/failed attach near the aggregate cap (R188): appShotPayloadToAttachments
          // returns the image + a metadata sidecar, either of which addAttachments may reject when the
          // store is near the ceiling. The paste is reported as handled, so warn rather than fail silent.
          const { skipped } = addAttachments(appShotPayloadToAttachments(payload));
          if (skipped.length > 0) {
            console.warn(`[appshot] Couldn't attach ${skipped.length} app-shot part(s) — attachment size cap reached.`);
          }
          return;
        }
        if (imageFiles.length === 0) return;
        // Gate the WHOLE batch before reading (R186): a per-file-only cap lets several raw clipboard
        // images materialize concurrently past the aggregate limit. filterAttachmentsBySize applies the
        // per-file AND running aggregate caps up front.
        const { accepted, reservedBytes } = filterAttachmentsBySize(imageFiles, getResidentBytes());
        // Release the in-flight reservation once every reader settles (R187).
        let outstanding = accepted.length;
        const settleOne = () => {
          outstanding -= 1;
          if (outstanding <= 0) releaseAttachmentReservation(reservedBytes);
        };
        if (accepted.length === 0) releaseAttachmentReservation(reservedBytes);
        for (const file of accepted) {
          const reader = new FileReader();
          reader.onerror = () => settleOne();
          reader.onabort = () => settleOne();
          reader.onload = () => {
            settleOne();
            if (getActiveConversationId() !== originConversationId) return;
            addAttachments([
              {
                name: file.name || `appshot-${refId}.png`,
                mime: file.type || 'image/png',
                isImage: true,
                size: file.size,
                dataUrl: reader.result as string,
              },
            ]);
          };
          reader.readAsDataURL(file);
        }
      });
      return true;
    },
    [addAttachments, getActiveConversationId, getResidentBytes],
  );
}
