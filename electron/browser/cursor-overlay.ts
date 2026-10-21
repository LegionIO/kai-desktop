import { WebContentsView, type BaseWindow } from 'electron';

/** Matches the computer-use CursorIndicator: glowing ring, filled dot, ping on click. */
const CURSOR_SIZE = 56;
const CURSOR_HALF = CURSOR_SIZE / 2;
const MOVE_TRANSITION_MS = 220;

export type BrowserCursorKind = 'move' | 'click';

type ViewBounds = { x: number; y: number; width: number; height: number };

function cursorDocument(hue: string): string {
  // Self-contained, script-only-for-presentation document. It has no preload,
  // no Node, no network, and receives coordinates only via executeJavaScript
  // from main, so it exposes no capability to the inspected page.
  const ring = `oklch(0.68 0.10 ${hue} / 80%)`;
  const fill = `oklch(0.60 0.12 ${hue} / 80%)`;
  const border = `oklch(0.70 0.08 ${hue} / 80%)`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;pointer-events:none}
.c{position:absolute;left:50%;top:50%;border-radius:50%;transform:translate(-50%,-50%)}
.ring{width:40px;height:40px;border:2px solid ${ring};box-shadow:0 0 16px 6px ${ring};box-sizing:border-box}
.dot{width:16px;height:16px;background:${fill};border:1px solid ${border};box-sizing:border-box}
.ping{width:48px;height:48px;border:2px solid ${ring};box-sizing:border-box;opacity:0}
.ping.on{animation:ping 800ms cubic-bezier(0,0,0.2,1)}
@keyframes ping{0%{transform:translate(-50%,-50%) scale(.6);opacity:.9}100%{transform:translate(-50%,-50%) scale(1.6);opacity:0}}
</style></head><body><div class="c ring"></div><div class="c dot"></div><div class="c ping" id="p"></div>
<script>window.__kaiPing=function(){var p=document.getElementById('p');p.classList.remove('on');void p.offsetWidth;p.classList.add('on');};</script>
</body></html>`;
}

/**
 * Native, click-through cursor rendered above a Browser page view. It is a
 * sibling WebContentsView (not page DOM and not a DevTools highlight), so page
 * scripts cannot observe it, it never participates in hit-testing, and it can
 * draw the same round cursor computer use shows on the desktop.
 */
export class BrowserCursorOverlay {
  private view: WebContentsView | null = null;
  private host: BaseWindow | null = null;
  private ready: Promise<void> | null = null;
  private visible = false;
  private moveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly hue: string) {}

  private ensureView(host: BaseWindow): WebContentsView | null {
    if (host.isDestroyed()) return null;
    if (this.view && !this.view.webContents.isDestroyed() && this.host === host) return this.view;
    this.dispose();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true,
        webSecurity: true,
        disableDialogs: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    view.webContents.setIgnoreMenuShortcuts?.(true);
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    host.contentView.addChildView(view);
    this.view = view;
    this.host = host;
    this.ready = view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cursorDocument(this.hue))}`)
      .catch(() => undefined);
    return view;
  }

  /** Place the cursor centred on a point inside `pageBounds` (window DIPs). */
  show(host: BaseWindow, pageBounds: ViewBounds, point: { x: number; y: number }, kind: BrowserCursorKind): void {
    const view = this.ensureView(host);
    if (!view) return;
    const x = Math.round(pageBounds.x + Math.min(Math.max(point.x, 0), pageBounds.width) - CURSOR_HALF);
    const y = Math.round(pageBounds.y + Math.min(Math.max(point.y, 0), pageBounds.height) - CURSOR_HALF);
    // Keep the cursor above the page view. Electron moves an existing child to
    // the top when it is re-added; only do so when something was stacked above.
    try {
      const children = host.contentView.children;
      if (children[children.length - 1] !== view) host.contentView.addChildView(view);
    } catch {
      return;
    }
    const target = { x, y, width: CURSOR_SIZE, height: CURSOR_SIZE };
    if (!this.visible) {
      view.setBounds(target);
      view.setVisible(true);
      this.visible = true;
    } else {
      this.animateTo(view, target);
    }
    if (kind === 'click') {
      void this.ready?.then(() => {
        if (!view.webContents.isDestroyed()) {
          void view.webContents
            .executeJavaScript('window.__kaiPing && window.__kaiPing()', false)
            .catch(() => undefined);
        }
      });
    }
  }

  /** Native views cannot CSS-transition their bounds; step them instead. */
  private animateTo(view: WebContentsView, target: ViewBounds): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    const start = view.getBounds();
    const startedAt = Date.now();
    const step = (): void => {
      if (view.webContents.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - startedAt) / MOVE_TRANSITION_MS);
      const eased = 1 - (1 - t) ** 3;
      view.setBounds({
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased),
        width: target.width,
        height: target.height,
      });
      this.moveTimer = t < 1 ? setTimeout(step, 16) : null;
    };
    step();
  }

  hide(): void {
    if (this.moveTimer) clearTimeout(this.moveTimer);
    this.moveTimer = null;
    this.visible = false;
    try {
      this.view?.setVisible(false);
    } catch {
      // The view may already be tearing down with its window.
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  dispose(): void {
    this.hide();
    const view = this.view;
    const host = this.host;
    this.view = null;
    this.host = null;
    this.ready = null;
    if (!view) return;
    try {
      if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
    } catch {
      // Best effort during window teardown.
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      // Already closed.
    }
  }
}
