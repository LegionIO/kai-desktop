import { useCallback, useEffect } from 'react';
import { parseAppShotRef, type AppShotPayload } from '../../shared/app-shots';
import { app } from '@/lib/ipc-client';
import { useAttachments, type AttachedFile } from '@/providers/AttachmentContext';

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
  const { addAttachments } = useAttachments();

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
      void app.appShots.resolveRef(refId).then((payload) => {
        if (payload) {
          addAttachments(appShotPayloadToAttachments(payload));
          return;
        }
        if (imageFiles.length === 0) return;
        for (const file of imageFiles) {
          const reader = new FileReader();
          reader.onload = () => {
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
    [addAttachments],
  );
}
