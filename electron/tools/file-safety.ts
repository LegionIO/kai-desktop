/**
 * File safety utilities: staleness detection, encoding preservation,
 * and file size guards for write/edit operations.
 *
 * Inspired by Claude Code's FileEditTool (staleness checking, encoding detection).
 */

import { createHash } from 'crypto';
import { stat, readFile } from 'fs/promises';

export type FileMetadata = {
  path: string;
  mtimeMs: number;
  size: number;
  contentHash: string;
  encoding: FileEncoding;
  lineEnding: LineEnding;
};

export type FileEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';
export type LineEnding = 'lf' | 'crlf' | 'mixed';

const MAX_FILE_SIZE = 1_073_741_824; // 1 GB

/** Per-conversation file metadata cache. */
const conversationCaches = new Map<string, Map<string, FileMetadata>>();

export function getConversationCache(conversationId: string): Map<string, FileMetadata> {
  let cache = conversationCaches.get(conversationId);
  if (!cache) {
    cache = new Map();
    conversationCaches.set(conversationId, cache);
  }
  return cache;
}

export function clearConversationCache(conversationId: string): void {
  conversationCaches.delete(conversationId);
}

/** Detect file encoding from BOM (Byte Order Mark). */
export function detectEncoding(buffer: Buffer): FileEncoding {
  // UTF-16 LE BOM: FF FE
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return 'utf-16le';
  }
  // UTF-16 BE BOM: FE FF
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    return 'utf-16be';
  }
  return 'utf-8';
}

/** Detect line ending style in text content. */
export function detectLineEnding(content: string): LineEnding {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;

  if (crlfCount > 0 && lfCount > 0) return 'mixed';
  if (crlfCount > 0) return 'crlf';
  return 'lf';
}

/** Compute a fast content hash for staleness detection. */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Read a file and cache its metadata for staleness detection.
 * Call this from file_read tool to populate the cache.
 */
export async function readFileWithMetadata(
  path: string,
  conversationId: string,
): Promise<{ content: string; metadata: FileMetadata }> {
  const fileStat = await stat(path);

  if (fileStat.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${fileStat.size} bytes, max ${MAX_FILE_SIZE}). Cannot safely process.`);
  }

  const buffer = await readFile(path);
  const encoding = detectEncoding(buffer);

  let content: string;
  if (encoding === 'utf-16le') {
    content = buffer.toString('utf16le');
    // Strip BOM if present
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  } else if (encoding === 'utf-16be') {
    // Node doesn't have native UTF-16BE, swap bytes then decode as UTF-16LE
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const tmp = buffer[i];
      buffer[i] = buffer[i + 1];
      buffer[i + 1] = tmp;
    }
    content = buffer.toString('utf16le');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  } else {
    content = buffer.toString('utf-8');
    // Strip UTF-8 BOM if present
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  }

  const lineEnding = detectLineEnding(content);
  const contentHash = computeContentHash(content);

  const metadata: FileMetadata = {
    path,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    contentHash,
    encoding,
    lineEnding,
  };

  // Cache it for this conversation
  const cache = getConversationCache(conversationId);
  cache.set(path, metadata);

  return { content, metadata };
}

/**
 * Check if a file has been modified externally since it was last read.
 * Returns null if the file is unchanged, or an error message if stale.
 */
export async function checkStaleness(
  path: string,
  conversationId: string,
): Promise<string | null> {
  const cache = getConversationCache(conversationId);
  const cached = cache.get(path);

  if (!cached) {
    // File was never read in this conversation — allow the write
    // (first write without prior read is acceptable for new file creation)
    return null;
  }

  try {
    const fileStat = await stat(path);

    // Quick check: mtime hasn't changed
    if (fileStat.mtimeMs === cached.mtimeMs && fileStat.size === cached.size) {
      return null;
    }

    // mtime changed — verify content hash
    const currentContent = await readFile(path, 'utf-8');
    const currentHash = computeContentHash(currentContent);

    if (currentHash === cached.contentHash) {
      // Content unchanged despite mtime change (e.g., touch command)
      return null;
    }

    return `File "${path}" was modified externally since it was last read. Please read the file again before editing to avoid overwriting changes.`;
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return `File "${path}" was deleted since it was last read.`;
    }
    return null; // On error, allow the write attempt
  }
}

/**
 * Check file size before write operations.
 * Returns an error message if the file exceeds the limit, null otherwise.
 */
export async function checkFileSize(path: string): Promise<string | null> {
  try {
    const fileStat = await stat(path);
    if (fileStat.size > MAX_FILE_SIZE) {
      return `File is too large (${(fileStat.size / (1024 * 1024 * 1024)).toFixed(2)} GB). Maximum supported size is 1 GB.`;
    }
  } catch {
    // File doesn't exist yet — OK for creation
  }
  return null;
}

/**
 * Encode content with the same encoding as the original file.
 */
export function encodeContent(content: string, encoding: FileEncoding, lineEnding: LineEnding): Buffer {
  // Normalize line endings to match original
  let normalized = content;
  if (lineEnding === 'crlf') {
    // Convert any lone LF to CRLF
    normalized = content.replace(/(?<!\r)\n/g, '\r\n');
  } else if (lineEnding === 'lf') {
    // Convert any CRLF to LF
    normalized = content.replace(/\r\n/g, '\n');
  }
  // 'mixed' — leave as-is

  if (encoding === 'utf-16le') {
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from(normalized, 'utf16le');
    return Buffer.concat([bom, body]);
  }

  if (encoding === 'utf-16be') {
    const bom = Buffer.from([0xFE, 0xFF]);
    const body = Buffer.from(normalized, 'utf16le');
    // Swap bytes for BE
    for (let i = 0; i < body.length - 1; i += 2) {
      const tmp = body[i];
      body[i] = body[i + 1];
      body[i + 1] = tmp;
    }
    return Buffer.concat([bom, body]);
  }

  // UTF-8
  return Buffer.from(normalized, 'utf-8');
}

/**
 * Update the cached metadata after a successful write.
 */
export function updateCacheAfterWrite(
  path: string,
  conversationId: string,
  content: string,
  encoding: FileEncoding,
  lineEnding: LineEnding,
  newMtimeMs: number,
  newSize: number,
): void {
  const cache = getConversationCache(conversationId);
  cache.set(path, {
    path,
    mtimeMs: newMtimeMs,
    size: newSize,
    contentHash: computeContentHash(content),
    encoding,
    lineEnding,
  });
}
