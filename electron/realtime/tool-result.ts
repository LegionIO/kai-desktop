import { extractModelContent } from '../agent/tool-model-content.js';

/** Realtime function-call outputs are JSON-only. Native `_modelContent` cannot
 * be delivered as an input image on this transport, and serializing it would
 * turn a PNG into a multi-megabyte base64 string. Strip it before both
 * compaction and websocket/renderer delivery and leave a small notice. */
export function sanitizeRealtimeToolResult(result: unknown): unknown {
  const { modelContent, cleaned } = extractModelContent(result);
  if (!modelContent) return cleaned;
  const omittedMedia = modelContent.some((part) => part.type === 'image' || part.type === 'file');
  const textNotices = modelContent.filter((part) => part.type === 'text').map((part) => part.text);
  if (!omittedMedia && textNotices.length === 0) return cleaned;
  const notices = [
    ...(omittedMedia ? ['Native image/file content is unavailable during a Realtime call.'] : []),
    ...textNotices,
  ];
  const notice = {
    mediaOmitted: true,
    mediaNotice: notices.join('\n'),
  };
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    return { ...(cleaned as Record<string, unknown>), ...notice };
  }
  return { result: cleaned, ...notice };
}
