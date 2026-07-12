/**
 * Guard for handing URLs to the OS via shell.openExternal. Displayed chat
 * content and tool output are partially untrusted, and openExternal launches
 * the OS handler for whatever scheme the URL carries: `file:`/`smb:` (NTLM
 * credential leak over UNC on Windows) or a registered custom protocol
 * (launches an app with attacker-controlled arguments). Only http(s)/mailto are
 * safe to open externally; everything else — and any unparseable input — is
 * rejected.
 */
export function isExternallyOpenableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:';
}
