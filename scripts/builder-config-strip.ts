/**
 * Pure helpers for generate-builder-config.ts, extracted so they can be unit
 * tested without triggering that module's on-import file-generation side effect.
 */

/**
 * Remove a top-level YAML block: the line `key:` at column 0 through the line
 * before the next column-0 key. A block line is either indented content or a
 * blank line; both are consumed so an interior blank line doesn't truncate the
 * block. Used to strip the `win`/`nsis` targets when KAI_DISABLE_WIN_BUILD is
 * set (#82 / ADR-0005); Windows builds by default (experimental-on).
 */
export function stripTopLevelBlock(yaml: string, key: string): string {
  return yaml.replace(new RegExp(`(^|\\n)${key}:[^\\n]*\\n(?:[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*`, 'g'), '$1');
}

/** Single-quote a YAML scalar, escaping embedded single quotes by doubling. */
export function toYamlSingleQuotedPath(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Whether to strip the Windows (`win`/`nsis`) targets from the generated
 * electron-builder config. Windows builds BY DEFAULT (experimental-on posture);
 * it is stripped ONLY when KAI_DISABLE_WIN_BUILD is set (e.g. a mac-only
 * release). The legacy KAI_ENABLE_WIN_BUILD is a no-op (accepted for backwards
 * compat but no longer required, since including Windows is now the default).
 * Pure so the generator's default-on gate can be unit-tested.
 */
export function shouldStripWindowsTargets(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.KAI_DISABLE_WIN_BUILD;
}
