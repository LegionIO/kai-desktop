import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const views = vi.hoisted(() => [] as FakeView[]);

type FakeView = {
  options: Record<string, unknown>;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  setBounds: ReturnType<typeof vi.fn>;
  getBounds: () => { x: number; y: number; width: number; height: number };
  setVisible: ReturnType<typeof vi.fn>;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  webContents: {
    destroyed: boolean;
    isDestroyed: () => boolean;
    loadURL: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    setIgnoreMenuShortcuts: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
};

vi.mock('electron', () => ({
  WebContentsView: class {
    constructor(options: Record<string, unknown>) {
      const view: FakeView = {
        options,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        visible: true,
        setBounds: vi.fn((bounds) => {
          view.bounds = bounds;
        }),
        getBounds: () => view.bounds,
        setVisible: vi.fn((visible: boolean) => {
          view.visible = visible;
        }),
        setBackgroundColor: vi.fn(),
        webContents: {
          destroyed: false,
          isDestroyed: () => view.webContents.destroyed,
          loadURL: vi.fn(async () => undefined),
          executeJavaScript: vi.fn(async () => undefined),
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          setIgnoreMenuShortcuts: vi.fn(),
          close: vi.fn(() => {
            view.webContents.destroyed = true;
          }),
        },
      };
      views.push(view);
      return view as unknown as object;
    }
  },
}));

const { BrowserCursorOverlay } = await import('../cursor-overlay.js');

function fakeHost() {
  const children: unknown[] = [];
  return {
    children,
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
        children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      }),
    },
  };
}

const page = { x: 200, y: 50, width: 800, height: 600 };

describe('BrowserCursorOverlay', () => {
  beforeEach(() => {
    views.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a round, sandboxed, script-isolated cursor document', () => {
    const overlay = new BrowserCursorOverlay('292');
    overlay.show(fakeHost() as never, page, { x: 10, y: 10 }, 'move');

    const view = views[0]!;
    expect(view.options).toMatchObject({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    expect(view.options.webPreferences).not.toHaveProperty('preload');
    const url = String(view.webContents.loadURL.mock.calls[0]?.[0]);
    expect(url.startsWith('data:text/html')).toBe(true);
    const html = decodeURIComponent(url.slice(url.indexOf(',') + 1));
    expect(html).toContain('border-radius:50%');
    expect(html).toContain('oklch(0.68 0.10 292');
    expect(view.setBackgroundColor).toHaveBeenCalledWith('#00000000');
  });

  it('centres the cursor on the point in window coordinates and keeps it inside the page', () => {
    const overlay = new BrowserCursorOverlay('292');
    const host = fakeHost();
    overlay.show(host as never, page, { x: 100, y: 40 }, 'move');
    expect(views[0]!.bounds).toEqual({ x: 272, y: 62, width: 56, height: 56 });
    expect(views[0]!.visible).toBe(true);

    overlay.hide();
    overlay.show(host as never, page, { x: -50, y: 5_000 }, 'move');
    expect(views[0]!.bounds).toEqual({ x: 172, y: 622, width: 56, height: 56 });
  });

  it('stays above a page view that was stacked after it', () => {
    const overlay = new BrowserCursorOverlay('292');
    const host = fakeHost();
    overlay.show(host as never, page, { x: 10, y: 10 }, 'move');
    const pageView = {};
    host.contentView.addChildView(pageView);
    overlay.show(host as never, page, { x: 20, y: 20 }, 'move');
    expect(host.children.at(-1)).toBe(views[0]);
  });

  it('eases subsequent moves instead of jumping', () => {
    const overlay = new BrowserCursorOverlay('292');
    const host = fakeHost();
    overlay.show(host as never, page, { x: 0, y: 0 }, 'move');
    overlay.show(host as never, page, { x: 400, y: 300 }, 'move');
    const midway = views[0]!.bounds;
    expect(midway.x).toBeLessThan(200 + 400 - 28);
    vi.advanceTimersByTime(400);
    expect(views[0]!.bounds).toEqual({ x: 572, y: 322, width: 56, height: 56 });
  });

  it('plays the click ripple only for clicks', async () => {
    const overlay = new BrowserCursorOverlay('292');
    const host = fakeHost();
    overlay.show(host as never, page, { x: 0, y: 0 }, 'move');
    await vi.advanceTimersByTimeAsync(0);
    expect(views[0]!.webContents.executeJavaScript).not.toHaveBeenCalled();
    overlay.show(host as never, page, { x: 0, y: 0 }, 'click');
    await vi.advanceTimersByTimeAsync(0);
    expect(views[0]!.webContents.executeJavaScript).toHaveBeenCalledOnce();
  });

  it('hides without destroying, and dispose removes and closes the view', () => {
    const overlay = new BrowserCursorOverlay('292');
    const host = fakeHost();
    overlay.show(host as never, page, { x: 0, y: 0 }, 'move');
    overlay.hide();
    expect(overlay.isVisible()).toBe(false);
    expect(views[0]!.visible).toBe(false);
    expect(views[0]!.webContents.close).not.toHaveBeenCalled();

    overlay.dispose();
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
  });

  it('rebuilds its view on a different host window', () => {
    const overlay = new BrowserCursorOverlay('292');
    const first = fakeHost();
    const second = fakeHost();
    overlay.show(first as never, page, { x: 0, y: 0 }, 'move');
    overlay.show(second as never, page, { x: 0, y: 0 }, 'move');
    expect(views).toHaveLength(2);
    expect(views[0]!.webContents.close).toHaveBeenCalledOnce();
    expect(second.children).toContain(views[1]);
  });
});
