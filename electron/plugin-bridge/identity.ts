import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { hash, packageFile, readBoundedFile } from './files.js';
import type { McpPlan } from './types.js';

/** Equivalence is deliberately narrower than access approval. A different
 * account, data directory, executable installation or environment is not an
 * interchangeable source, even if both packages have the same display name. */
export function mcpComponentIdentity(plan: McpPlan, native = false): string {
  return hash({
    kind: 'mcp',
    // Normalize absent fields as well as values: native HTTP configuration
    // omits command, while an imported manifest may explicitly set undefined.
    command: plan.command ?? null,
    url: plan.url ? new URL(plan.url).href : null,
    args: plan.args,
    env: plan.env,
    headers: Object.fromEntries(Object.entries(plan.headers).map(([key, value]) => [key.toLowerCase(), value])),
    transport: plan.transport,
    origin: plan.origin,
    ...(!plan.url ? { environmentPolicy: native ? 'native' : 'bridge-session' } : {}),
  });
}

/** Include supporting files, not just SKILL.md. If the package cannot be
 * compared within the bound, report possible overlap rather than equivalence. */
export function packageContentIdentity(root: string): string {
  try {
    const files: Array<[string, string]> = [];
    let bytes = 0;
    const walk = (path: string, depth = 0) => {
      if (depth > 20) throw new Error('Package depth limit.');
      for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (path === root && ['.claude-plugin', '.codex-plugin', '.git', 'plugin.json'].includes(entry.name)) continue;
        const file = packageFile(root, join(path, entry.name));
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile()) {
          const content = readBoundedFile(file, 2 * 1024 * 1024);
          bytes += Buffer.byteLength(content);
          if (bytes > 8 * 1024 * 1024 || files.length >= 1000) throw new Error('Package comparison limit.');
          files.push([relative(root, file), hash(content)]);
        } else throw new Error('Package cannot be compared safely.');
      }
    };
    walk(root);
    return hash(files);
  } catch {
    return '';
  }
}
export function skillComponentIdentity(
  root: string,
  directory: string,
  contentIdentity = packageContentIdentity(root),
): string {
  return contentIdentity ? hash({ kind: 'skill', directory: relative(root, directory), contentIdentity }) : '';
}

export function componentPluginId(id: string): string {
  const delimiter = /\/(?:mcp|skill|hooks|unsupported)\//.exec(id);
  return delimiter ? id.slice(0, delimiter.index) : id;
}
