import type { WebContents } from 'electron';

/** SAML auto-submit and script redirects can replace a navigation mid-load. */
export function isSupersededLoadAbort(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    ((error as { code?: unknown }).code === 'ERR_ABORTED' || (error as { errno?: unknown }).errno === -3)
  );
}

/** Keep a live replacement navigation running; this does not establish auth success. */
export async function loadUrlAllowingRedirect(
  contents: Pick<WebContents, 'loadURL' | 'isDestroyed'>,
  url: string,
): Promise<void> {
  try {
    await contents.loadURL(url);
  } catch (error) {
    if (!isSupersededLoadAbort(error) || contents.isDestroyed()) throw error;
  }
}
