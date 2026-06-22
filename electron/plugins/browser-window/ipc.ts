export const PB = {
  shortcut: 'plugin-browser:shortcut',
  openTab: 'plugin-browser:open-tab',
  download: 'plugin-browser:download',
  authPrompt: 'plugin-browser:auth-prompt',
  authSubmit: 'plugin-browser:auth-submit',
  openExternal: 'plugin-browser:open-external',
  showInFolder: 'plugin-browser:show-in-folder',
  zoomChanged: 'plugin-browser:zoom-changed',
  getZoom: 'plugin-browser:get-zoom',
} as const;

export type ShortcutAction =
  | 'find'
  | 'find-next'
  | 'find-prev'
  | 'new-tab'
  | 'reopen-tab'
  | 'close-tab'
  | 'focus-url'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'tab-n'
  | 'tab-last'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'devtools';

export interface ShortcutPayload {
  action: ShortcutAction;
  arg?: number;
}

export interface OpenTabPayload {
  url: string;
  background: boolean;
}

export interface DownloadPayload {
  id: number;
  filename: string;
  received: number;
  total: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  path: string;
}

export interface AuthPromptPayload {
  id: number;
  host: string;
  realm: string;
  isProxy: boolean;
}

export interface AuthSubmitPayload {
  id: number;
  username?: string;
  password?: string;
  cancel?: boolean;
}

export interface BrowserApi {
  onShortcut: (cb: (p: ShortcutPayload) => void) => () => void;
  onOpenTab: (cb: (p: OpenTabPayload) => void) => () => void;
  onDownload: (cb: (p: DownloadPayload) => void) => () => void;
  onAuthPrompt: (cb: (p: AuthPromptPayload) => void) => () => void;
  onMenuFind: (cb: () => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  showInFolder: (path: string) => Promise<void>;
  submitAuth: (r: AuthSubmitPayload) => Promise<void>;
  reportZoom: (partition: string, level: number) => Promise<void>;
  getZoom: (partition: string) => Promise<number>;
}
