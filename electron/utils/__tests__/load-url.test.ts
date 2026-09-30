import { describe, it, expect, vi } from 'vitest';
import { loadUrlAllowingRedirect } from '../load-url.js';

describe('auth and browser navigation redirects', () => {
  it.each([{ code: 'ERR_ABORTED' }, { errno: -3 }])('keeps live SSO redirects running (%j)', async (details) => {
    const error = Object.assign(new Error('SSO navigation replaced the initial document'), details);
    const contents = { loadURL: vi.fn().mockRejectedValue(error), isDestroyed: () => false };
    await expect(loadUrlAllowingRedirect(contents, 'https://service.example/login')).resolves.toBeUndefined();
    expect(contents.loadURL).toHaveBeenCalledExactlyOnceWith('https://service.example/login');
  });

  it('rejects cancellation after the renderer is destroyed', async () => {
    const error = Object.assign(new Error('closed'), { code: 'ERR_ABORTED', errno: -3 });
    await expect(
      loadUrlAllowingRedirect(
        { loadURL: vi.fn().mockRejectedValue(error), isDestroyed: () => true },
        'https://service.example/login',
      ),
    ).rejects.toBe(error);
  });

  it('preserves network and certificate failures', async () => {
    for (const code of ['ERR_CONNECTION_REFUSED', 'ERR_CERT_AUTHORITY_INVALID']) {
      const error = Object.assign(new Error('load failed'), { code });
      await expect(
        loadUrlAllowingRedirect(
          { loadURL: vi.fn().mockRejectedValue(error), isDestroyed: () => false },
          'https://service.example/login',
        ),
      ).rejects.toBe(error);
    }
  });
});
