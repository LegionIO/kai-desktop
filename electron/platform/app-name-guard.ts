/**
 * App-name guard for `open -a` (macOS) / `Start-Process` (Windows) / process
 * lookup. A model-supplied computer-use `openApp`/`focusApp` name must be a bare
 * application NAME, never a path — otherwise it can launch an arbitrary local or
 * UNC executable (`\\host\share\evil.exe`, `C:\evil.exe`) or a Windows
 * drive-relative path (`C:payload.exe`). Reject:
 *   - empty / whitespace-only
 *   - a leading `-` (option-like: `open`/`osascript` flag confusion)
 *   - path separators `/` `\`
 *   - `:` (Windows drive-relative/absolute + alternate-data-stream)
 *   - control chars / NUL
 * A bare name (`notepad`, `Safari`) still resolves via the OS's normal
 * app/PATH lookup. Returns the trimmed name or throws.
 */
export function assertPlainAppName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('App name is required.');
  if (trimmed.startsWith('-')) {
    throw new Error(`Refusing an application name that begins with '-': ${trimmed}`);
  }
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(':')) {
    throw new Error(`Refusing an application path; provide a name, not a path: ${trimmed}`);
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(`Refusing an application name with control characters: ${JSON.stringify(trimmed)}`);
  }
  return trimmed;
}
