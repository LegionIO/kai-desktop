/**
 * Appshots (#81) — metadata-enhanced, PERSISTED screenshots of apps
 * ("snapshot+"): an image saved with structured metadata, browsable in a
 * settings gallery and re-attachable into a chat.
 *
 * Distinct from `shared/app-shots.ts` (`AppShotPayload`), which is the
 * EPHEMERAL capture-to-attach/inline mechanism (in-memory data URL, ref-based
 * composer inlining). An Appshot is durably stored: bytes at
 * `~/.kai/data/appshots/<id>.jpg`, metadata in `index.json`. `dataUrl` is
 * reconstructed on demand and NEVER persisted; `imageRef` is a BARE filename
 * (`"<id>.jpg"`), never a path.
 */

/** Structured metadata captured alongside an appshot image. */
export interface AppshotMetadata {
  /** App/window name at capture time. */
  appName?: string;
  windowTitle?: string;
  /** Optional visible text (only when captureVisibleText is enabled). */
  visibleText?: string;
  /** Display layout summary (index + dimensions). */
  display?: { index: number; width: number; height: number };
  /** The action that triggered the capture (e.g. a computer-use action kind). */
  triggeringAction?: string;
}

export interface Appshot {
  id: string;
  /** ISO timestamp of capture. */
  createdAt: string;
  /** Bare image filename ("<id>.jpg") — NEVER a path. Re-validated on read. */
  imageRef: string;
  /** Byte size of the stored image. */
  imageBytes: number;
  /** Conversation this appshot originated from, if any. */
  conversationId?: string;
  metadata: AppshotMetadata;
  /** User tags. */
  tags: string[];
  /** Pinned appshots are exempt from age/count eviction (but still count toward the byte ceiling). */
  pinned: boolean;
}

export interface AppshotIndex {
  version: 1;
  appshots: Appshot[];
}

export interface CreateAppshotInput {
  /** JPEG bytes (already harness-redacted). */
  imageData: Uint8Array;
  conversationId?: string;
  metadata: AppshotMetadata;
}

/** An appshot id: "appshot-<epoch-ms>-<8 hex>". Matches makeComputerUseId('appshot'). */
export const APPSHOT_ID_RE = /^appshot-\d+-[0-9a-f]{8}$/;

/** True only for a strictly well-formed appshot id (no traversal/NUL/case tricks). */
export function isValidAppshotId(id: unknown): id is string {
  return typeof id === 'string' && APPSHOT_ID_RE.test(id);
}

/** The canonical bare image filename for an appshot id. */
export function appshotImageFilename(id: string): string {
  return `${id}.jpg`;
}

/** True if `ref` is a bare "<validId>.jpg" filename (no separators/traversal). */
export function isValidImageRef(ref: unknown): ref is string {
  if (typeof ref !== 'string') return false;
  if (!ref.endsWith('.jpg')) return false;
  const id = ref.slice(0, -'.jpg'.length);
  return isValidAppshotId(id);
}
