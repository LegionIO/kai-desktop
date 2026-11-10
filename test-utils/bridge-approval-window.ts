import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions, IpcMainInvokeEvent } from 'electron';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
export const approvalWindows: ApprovalWindowFixture[] = [];

export class ApprovalWindowFixture extends EventEmitter {
  destroyed = false;
  handlers = new Map<string, Handler>();
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: '' },
    ipc: { handle: (name: string, handler: Handler) => this.handlers.set(name, handler) },
    session: { setPermissionRequestHandler: () => {}, setPermissionCheckHandler: () => {} },
    setWindowOpenHandler: () => {},
  });
  constructor(readonly options: BrowserWindowConstructorOptions = {}) {
    super();
    approvalWindows.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  getBounds() {
    return { x: 0, y: 0, width: 1024, height: 768 };
  }
  focus() {}
  show() {}
  async loadURL(url: string) {
    this.webContents.mainFrame.url = url;
  }
  event(): IpcMainInvokeEvent {
    return { sender: this.webContents, senderFrame: this.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
  }
  invoke(channel: string, ...args: unknown[]) {
    return this.handlers.get(channel)!(this.event(), ...args);
  }
}
