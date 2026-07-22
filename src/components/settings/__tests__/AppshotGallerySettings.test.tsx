// @vitest-environment jsdom
/**
 * Component test for AppshotsSettings (#81) — gallery render + "Attach to chat".
 * window.app.appShots and the attachment context are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import type { Appshot } from '../../../../shared/appshots';

const sampleAppshot: Appshot = {
  id: 'appshot-1767225600000-deadbeef',
  createdAt: '2026-01-01T00:00:00.000Z',
  imageRef: 'appshot-1767225600000-deadbeef.jpg',
  imageBytes: 1234,
  metadata: { appName: 'Safari', windowTitle: 'Example' },
  tags: ['ui'],
  pinned: false,
};

// vi.hoisted so the mock factories (also hoisted) can reference these.
const { addAttachments, appshotsApi } = vi.hoisted(() => ({
  addAttachments: vi.fn(),
  appshotsApi: {
    list: vi.fn(),
    get: vi.fn(),
    getImage: vi.fn(),
    delete: vi.fn(),
    deleteAll: vi.fn(),
    update: vi.fn(),
    onChanged: vi.fn(() => () => {}),
  },
}));

vi.mock('@/providers/AttachmentContext', () => ({
  useAttachments: () => ({ addAttachments }),
}));

vi.mock('@/lib/ipc-client', () => ({
  app: { appShots: appshotsApi },
}));

import { AppshotsSettings } from '../AppshotGallerySettings';

const config = {
  appShots: {
    persisted: {
      enabled: true,
      autoCapture: false,
      captureVisibleText: false,
      retention: { maxCount: 200, maxAgeDays: 30, maxTotalBytes: 524288000 },
    },
  },
} as unknown as Record<string, unknown>;

beforeEach(() => {
  addAttachments.mockClear();
  appshotsApi.list.mockReset().mockResolvedValue([sampleAppshot]);
  appshotsApi.getImage.mockReset().mockResolvedValue('data:image/jpeg;base64,/9j/AAA=');
  appshotsApi.delete.mockReset().mockResolvedValue({ ok: true });
  appshotsApi.deleteAll.mockReset().mockResolvedValue({ ok: true });
  appshotsApi.update.mockReset().mockResolvedValue({ ok: true, appshot: sampleAppshot });
  appshotsApi.onChanged.mockReset().mockReturnValue(() => {});
});
afterEach(() => cleanup());

describe('AppshotsSettings', () => {
  it('renders the gallery from window.app.appshots.list', async () => {
    render(<AppshotsSettings config={config} updateConfig={vi.fn()} hideTitle />);
    await waitFor(() => expect(appshotsApi.list).toHaveBeenCalled());
    // Gallery legend shows the count.
    await waitFor(() => expect(screen.getByText(/Gallery \(1\)/)).toBeInTheDocument());
  });

  it('opens the viewer and attaches the appshot to chat', async () => {
    render(<AppshotsSettings config={config} updateConfig={vi.fn()} hideTitle />);
    await waitFor(() => expect(screen.getByText(/Gallery \(1\)/)).toBeInTheDocument());

    // Open the viewer by clicking the thumbnail button.
    fireEvent.click(screen.getByTitle('Safari'));
    await waitFor(() => expect(screen.getByTestId('appshot-viewer')).toBeInTheDocument());

    // Wait for the image to load, then attach.
    await waitFor(() => expect(appshotsApi.getImage).toHaveBeenCalledWith(sampleAppshot.id));
    const attachBtn = await screen.findByText('Attach to chat');
    await waitFor(() => expect((attachBtn.closest('button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(attachBtn);

    expect(addAttachments).toHaveBeenCalledTimes(1);
    const [files] = addAttachments.mock.calls[0];
    expect(files[0]).toMatchObject({ isImage: true, mime: 'image/jpeg', size: 1234 });
  });

  it('renders an empty state when there are no appshots', async () => {
    appshotsApi.list.mockResolvedValueOnce([]);
    render(<AppshotsSettings config={config} updateConfig={vi.fn()} hideTitle />);
    await waitFor(() => expect(screen.getByText('No appshots yet.')).toBeInTheDocument());
  });
});
