import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, realpathSync, constants } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function readBoundedFile(path: string, maxBytes = 2 * 1024 * 1024): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Expected a bounded regular file.');
    const data = Buffer.alloc(maxBytes + 1);
    let size = 0,
      count = 0;
    while (size < data.length && (count = readSync(fd, data, size, data.length - size, null)) > 0) size += count;
    if (size > maxBytes) throw new Error('File exceeds the bridge size limit.');
    return data.subarray(0, size).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Both lexical and real-path checks matter: packages may contain symlinks. */
export function packageFile(root: string, path: string): string {
  const canonicalRoot = realpathSync(root);
  const candidate = resolve(canonicalRoot, path);
  const contained = (value: string) => {
    const rel = relative(canonicalRoot, value);
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
  };
  if (!contained(candidate)) throw new Error('A component path escapes the installed package.');
  const canonical = realpathSync(candidate);
  if (!contained(canonical)) throw new Error('A component symlink escapes the installed package.');
  return canonical;
}

export function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : stableJson(value))
    .digest('hex');
}
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];
}
export function safeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 300) : fallback;
}

export function nativeBridgeSessionId(instanceId: string, id: string): string {
  return `kai:${instanceId}:${id.length <= 100 ? id : hash(id)}`;
}
