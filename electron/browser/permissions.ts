import { createHash } from 'node:crypto';

export type BrowserPermissionDetails = {
  mediaType?: 'video' | 'audio' | 'unknown';
  mediaTypes?: Array<'video' | 'audio'>;
  filePath?: string;
  isDirectory?: boolean;
  fileAccessType?: 'writable' | 'readable';
};

/** Normalize Chromium permission origins without collapsing every opaque page
 * into a persistable "null" bucket shared across unrelated documents. */
export function normalizeBrowserPermissionOrigin(value: string): string {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? 'opaque page' : origin;
  } catch {
    return 'unknown page';
  }
}

export function isPersistentBrowserPermissionOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.origin === origin;
  } catch {
    return false;
  }
}

/** File System Access grants are path-specific, but Chromium exposes no safe
 * durable display metadata for an already-hashed grant. Keep them request-only
 * so Kai never offers a remembered permission the user cannot identify later. */
export function isPersistableBrowserPermission(permission: string): boolean {
  return permission !== 'fileSystem';
}

export function browserPermissionTargetLabel(
  permission: string,
  details: BrowserPermissionDetails = {},
): string | undefined {
  if (permission !== 'fileSystem' || !details.filePath) return undefined;
  const sanitized = details.filePath.replace(/[\u0000-\u001f\u007f]/g, '\ufffd');
  const bounded = sanitized.length > 512 ? `\u2026${sanitized.slice(-511)}` : sanitized;
  return `${details.isDirectory ? 'Directory' : 'File'}: ${bounded}`;
}

/**
 * Chromium's top-level permission name is not always a complete grant scope.
 * Media grants are per device class, while File System Access grants are tied
 * to a concrete path, access mode, and file/directory kind. Persist only keys
 * that preserve those details so allowing a microphone or one writable file
 * cannot silently authorize a camera or a different path later.
 */
export function browserPermissionStorageKeys(permission: string, details: BrowserPermissionDetails = {}): string[] {
  if (permission === 'media') {
    const mediaTypes = new Set<'video' | 'audio' | 'unknown'>();
    for (const mediaType of details.mediaTypes ?? []) mediaTypes.add(mediaType);
    if (details.mediaType) mediaTypes.add(details.mediaType);
    if (mediaTypes.size === 0) mediaTypes.add('unknown');
    return [...mediaTypes].sort().map((mediaType) => `media:${mediaType}`);
  }

  if (permission === 'fileSystem') {
    // Electron declares every scoping field optional. An incomplete request
    // cannot be safely remembered: caching a shared "unknown" key would let a
    // later request for another path or access mode reuse the grant.
    if (
      !details.filePath ||
      (details.fileAccessType !== 'readable' && details.fileAccessType !== 'writable') ||
      typeof details.isDirectory !== 'boolean'
    ) {
      return [];
    }
    const pathDigest = createHash('sha256').update(details.filePath).digest('hex');
    const access = details.fileAccessType;
    const kind = details.isDirectory ? 'directory' : 'file';
    return [`fileSystem:${access}:${kind}:${pathDigest}`];
  }

  return [permission];
}

export function describeBrowserPermission(permission: string, details: BrowserPermissionDetails = {}): string {
  if (permission === 'media') {
    const types = [...new Set(details.mediaTypes ?? (details.mediaType ? [details.mediaType] : []))];
    return types.length > 0 ? `media (${types.join(' and ')})` : 'media';
  }
  if (permission === 'fileSystem') {
    const access = details.fileAccessType ?? 'access';
    const kind = details.isDirectory ? 'directory' : 'file';
    return `file system (${access} ${kind})`;
  }
  return permission;
}
