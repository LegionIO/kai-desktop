import type {
  AuthPromptPayload,
  BrowserApi,
  DownloadPayload,
  ShortcutPayload,
} from '../../electron/plugins/browser-window/ipc';

type WebviewTag = Electron.WebviewTag;

declare global {
  interface Window {
    browserApi: BrowserApi;
  }
}

interface Tab {
  id: number;
  wv: WebviewTag;
  title: string;
  favicon: string;
  loading: boolean;
  errorOverlay: HTMLDivElement | null;
}

const params = new URLSearchParams(location.search);
const initialUrl = params.get('url') ?? 'about:blank';
const homeUrl = params.get('home') ?? initialUrl;
const partition = params.get('partition') ?? '';
const userAgent = params.get('ua') ?? '';

const api = window.browserApi;

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const container = $('#webview-container');
const tabsBar = $('#tabs');
const newTabBtn = $('#new-tab-btn');
const urlBar = $<HTMLInputElement>('#url-bar');
const backBtn = $<HTMLButtonElement>('#back-btn');
const fwdBtn = $<HTMLButtonElement>('#fwd-btn');
const reloadBtn = $<HTMLButtonElement>('#reload-btn');
const copyUrlBtn = $('#copy-url-btn');
const externalBtn = $('#external-btn');

const findBar = $('#find-bar');
const findInput = $<HTMLInputElement>('#find-input');
const findCount = $('#find-count');
const findPrevBtn = $('#find-prev-btn');
const findNextBtn = $('#find-next-btn');
const findCloseBtn = $('#find-close-btn');

const downloadShelf = $('#download-shelf');
const authModal = $('#auth-modal');
const authDetail = $('#auth-detail');
const authUser = $<HTMLInputElement>('#auth-user');
const authPass = $<HTMLInputElement>('#auth-pass');
const authSubmitBtn = $('#auth-submit');
const authCancelBtn = $('#auth-cancel');

let tabs: Tab[] = [];
let activeId: number | null = null;
let tabCounter = 0;
const closedStack: string[] = [];
let currentZoom = 0;
let zoomTouched = false;
let findText = '';
let pendingAuthId: number | null = null;

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------
function activeTab(): Tab | undefined {
  return tabs.find((t) => t.id === activeId);
}

function createTab(url: string, opts: { background?: boolean } = {}): number {
  const id = ++tabCounter;
  const wv = document.createElement('webview') as WebviewTag;
  wv.setAttribute('src', url);
  wv.setAttribute('allowpopups', '');
  if (partition) wv.setAttribute('partition', partition);
  if (userAgent) wv.setAttribute('useragent', userAgent);
  wv.className = 'hidden';
  wv.id = `wv-${id}`;
  container.appendChild(wv);

  const tab: Tab = { id, wv, title: 'Loading…', favicon: '', loading: true, errorOverlay: null };
  tabs.push(tab);

  wv.addEventListener('page-title-updated', (e) => {
    tab.title = e.title || url;
    renderTabs();
  });
  wv.addEventListener('page-favicon-updated', (e) => {
    tab.favicon = e.favicons[0] ?? '';
    renderTabs();
  });
  wv.addEventListener('did-start-loading', () => {
    tab.loading = true;
    clearError(tab);
    renderTabs();
    updateNavState();
  });
  wv.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    renderTabs();
    updateNavState();
  });
  wv.addEventListener('did-navigate', () => updateNavState());
  wv.addEventListener('did-navigate-in-page', () => updateNavState());
  wv.addEventListener('found-in-page', (e) => {
    if (tab.id !== activeId) return;
    const r = e.result;
    findCount.textContent = r.matches > 0 ? `${r.activeMatchOrdinal}/${r.matches}` : '0/0';
  });
  wv.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3 || !e.isMainFrame) return;
    showError(tab, e.errorCode, e.errorDescription, e.validatedURL);
  });
  wv.addEventListener('dom-ready', () => {
    if (currentZoom !== 0) {
      try {
        wv.setZoomLevel(currentZoom);
      } catch {
        /* webview may not be attached yet */
      }
    }
  });

  if (!opts.background) switchTab(id);
  renderTabs();
  return id;
}

function switchTab(id: number): void {
  const prev = activeTab();
  if (prev && prev.id !== id) {
    try {
      prev.wv.stopFindInPage('clearSelection');
    } catch {
      /* ignore */
    }
  }
  activeId = id;
  for (const t of tabs) {
    t.wv.classList.toggle('hidden', t.id !== id);
    if (t.errorOverlay) t.errorOverlay.classList.toggle('hidden', t.id !== id);
  }
  closeFind();
  renderTabs();
  updateNavState();
}

function closeTab(id: number): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = tabs[idx];
  try {
    const u = tab.wv.getURL();
    if (u && u !== 'about:blank') closedStack.push(u);
  } catch {
    /* ignore */
  }
  tab.wv.remove();
  tab.errorOverlay?.remove();
  tabs.splice(idx, 1);
  if (tabs.length === 0) {
    window.close();
    return;
  }
  if (activeId === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    switchTab(next.id);
  }
  renderTabs();
}

function renderTabs(): void {
  tabsBar.querySelectorAll('.tab').forEach((el) => el.remove());
  for (const t of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeId ? ' active' : '');

    if (t.loading) {
      const sp = document.createElement('div');
      sp.className = 'tab-spinner';
      el.appendChild(sp);
    } else if (t.favicon) {
      const img = document.createElement('img');
      img.className = 'tab-favicon';
      img.src = t.favicon;
      el.appendChild(img);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = t.title;
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.innerHTML = '&times;';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => switchTab(t.id));
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(t.id);
    });
    tabsBar.insertBefore(el, newTabBtn);
  }
}

function updateNavState(): void {
  const tab = activeTab();
  if (!tab) return;
  try {
    urlBar.value = tab.wv.getURL();
    backBtn.disabled = !tab.wv.canGoBack();
    fwdBtn.disabled = !tab.wv.canGoForward();
    reloadBtn.innerHTML = tab.loading ? '&times;' : '&#8635;';
    reloadBtn.title = tab.loading ? 'Stop' : 'Reload (⌘R)';
  } catch {
    /* webview not attached yet */
  }
}

// ---------------------------------------------------------------------------
// Find in page (#1)
// ---------------------------------------------------------------------------
function openFind(): void {
  findBar.classList.remove('hidden');
  findInput.focus();
  findInput.select();
  if (findText) doFind(true, false);
}

function closeFind(): void {
  if (findBar.classList.contains('hidden')) return;
  findBar.classList.add('hidden');
  findCount.textContent = '';
  const tab = activeTab();
  if (tab) {
    try {
      tab.wv.stopFindInPage('clearSelection');
    } catch {
      /* ignore */
    }
  }
}

function doFind(forward: boolean, next: boolean): void {
  const tab = activeTab();
  if (!tab || !findText) {
    findCount.textContent = '';
    return;
  }
  try {
    tab.wv.findInPage(findText, { forward, findNext: next });
  } catch {
    /* ignore */
  }
}

findInput.addEventListener('input', () => {
  findText = findInput.value;
  if (findText) doFind(true, false);
  else {
    findCount.textContent = '';
    activeTab()?.wv.stopFindInPage('clearSelection');
  }
});
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    doFind(!e.shiftKey, true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});
findPrevBtn.addEventListener('click', () => doFind(false, true));
findNextBtn.addEventListener('click', () => doFind(true, true));
findCloseBtn.addEventListener('click', () => closeFind());

// ---------------------------------------------------------------------------
// Error overlay (#7)
// ---------------------------------------------------------------------------
function showError(tab: Tab, code: number, desc: string, failedUrl: string): void {
  clearError(tab);
  const ov = document.createElement('div');
  ov.className = 'error-overlay' + (tab.id === activeId ? '' : ' hidden');
  ov.innerHTML = `
    <div class="error-desc"></div>
    <div class="error-code"></div>
    <button>Retry</button>
  `;
  (ov.querySelector('.error-desc') as HTMLElement).textContent = desc || 'This page could not be loaded.';
  (ov.querySelector('.error-code') as HTMLElement).textContent = `${failedUrl}  (error ${code})`;
  ov.querySelector('button')?.addEventListener('click', () => {
    clearError(tab);
    tab.wv.reload();
  });
  container.appendChild(ov);
  tab.errorOverlay = ov;
}

function clearError(tab: Tab): void {
  tab.errorOverlay?.remove();
  tab.errorOverlay = null;
}

// ---------------------------------------------------------------------------
// Zoom (#10)
// ---------------------------------------------------------------------------
function applyZoom(level: number): void {
  zoomTouched = true;
  currentZoom = Math.max(-6, Math.min(6, level));
  for (const t of tabs) {
    try {
      t.wv.setZoomLevel(currentZoom);
    } catch {
      /* ignore */
    }
  }
  void api.reportZoom(partition, currentZoom);
}

// ---------------------------------------------------------------------------
// Download shelf (#6)
// ---------------------------------------------------------------------------
const dlRows = new Map<number, HTMLDivElement>();

function renderDownload(d: DownloadPayload): void {
  downloadShelf.classList.remove('hidden');
  let row = dlRows.get(d.id);
  if (!row) {
    row = document.createElement('div');
    row.className = 'dl-item';
    row.innerHTML = `
      <span class="dl-name"></span>
      <span class="dl-status"></span>
      <button class="dl-show hidden">Show</button>
      <button class="dl-dismiss">&times;</button>
      <div class="dl-progress"></div>
    `;
    (row.querySelector('.dl-name') as HTMLElement).textContent = d.filename;
    row.querySelector('.dl-dismiss')?.addEventListener('click', () => {
      row?.remove();
      dlRows.delete(d.id);
      if (dlRows.size === 0) downloadShelf.classList.add('hidden');
    });
    row.querySelector('.dl-show')?.addEventListener('click', () => {
      const p = row?.dataset.path;
      if (p) void api.showInFolder(p);
    });
    downloadShelf.appendChild(row);
    dlRows.set(d.id, row);
  }
  if (d.path) row.dataset.path = d.path;
  const status = row.querySelector('.dl-status') as HTMLElement;
  const prog = row.querySelector('.dl-progress') as HTMLElement;
  const showBtn = row.querySelector('.dl-show') as HTMLElement;
  if (d.state === 'progressing') {
    const pct = d.total > 0 ? Math.round((d.received / d.total) * 100) : 0;
    status.textContent = d.total > 0 ? `${pct}%` : `${(d.received / 1e6).toFixed(1)} MB`;
    prog.style.width = `${pct}%`;
  } else if (d.state === 'completed') {
    status.textContent = 'Done';
    prog.style.width = '100%';
    showBtn.classList.remove('hidden');
  } else {
    status.textContent = d.state === 'cancelled' ? 'Cancelled' : 'Failed';
    prog.style.width = '0%';
  }
}

// ---------------------------------------------------------------------------
// Auth modal (#9)
// ---------------------------------------------------------------------------
function showAuthPrompt(p: AuthPromptPayload): void {
  if (pendingAuthId != null) void api.submitAuth({ id: pendingAuthId, cancel: true });
  pendingAuthId = p.id;
  authDetail.textContent = `${p.isProxy ? 'Proxy ' : ''}${p.host}${p.realm ? ` — ${p.realm}` : ''}`;
  authUser.value = '';
  authPass.value = '';
  authModal.classList.remove('hidden');
  authUser.focus();
}

function resolveAuth(cancel: boolean): void {
  if (pendingAuthId == null) return;
  const id = pendingAuthId;
  pendingAuthId = null;
  authModal.classList.add('hidden');
  void api.submitAuth(cancel ? { id, cancel: true } : { id, username: authUser.value, password: authPass.value });
}

authSubmitBtn.addEventListener('click', () => resolveAuth(false));
authCancelBtn.addEventListener('click', () => resolveAuth(true));
authPass.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') resolveAuth(false);
});
authUser.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') authPass.focus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pendingAuthId != null) resolveAuth(true);
});

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------
backBtn.addEventListener('click', () => activeTab()?.wv.goBack());
fwdBtn.addEventListener('click', () => activeTab()?.wv.goForward());
reloadBtn.addEventListener('click', () => {
  const t = activeTab();
  if (!t) return;
  if (t.loading) t.wv.stop();
  else t.wv.reload();
});
copyUrlBtn.addEventListener('click', () => {
  const u = activeTab()?.wv.getURL();
  if (u) void navigator.clipboard.writeText(u);
});
externalBtn.addEventListener('click', () => {
  const u = activeTab()?.wv.getURL();
  if (u) void api.openExternal(u);
});
urlBar.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  let val = urlBar.value.trim();
  if (!val) return;
  if (!/^https?:\/\//i.test(val)) val = 'https://' + val;
  activeTab()?.wv.loadURL(val);
});
newTabBtn.addEventListener('click', () => createTab(homeUrl));

// ---------------------------------------------------------------------------
// Shortcut dispatch (#2) + main-process events
// ---------------------------------------------------------------------------
function handleShortcut({ action, arg }: ShortcutPayload): void {
  const t = activeTab();
  switch (action) {
    case 'find':
      openFind();
      break;
    case 'find-next':
      if (!findBar.classList.contains('hidden')) doFind(true, true);
      else openFind();
      break;
    case 'find-prev':
      if (!findBar.classList.contains('hidden')) doFind(false, true);
      break;
    case 'new-tab':
      createTab(homeUrl);
      break;
    case 'reopen-tab': {
      const u = closedStack.pop();
      if (u) createTab(u);
      break;
    }
    case 'close-tab':
      if (t) closeTab(t.id);
      break;
    case 'focus-url':
      urlBar.focus();
      urlBar.select();
      break;
    case 'reload':
      t?.wv.reload();
      break;
    case 'hard-reload':
      t?.wv.reloadIgnoringCache();
      break;
    case 'back':
      if (t?.wv.canGoBack()) t.wv.goBack();
      break;
    case 'forward':
      if (t?.wv.canGoForward()) t.wv.goForward();
      break;
    case 'tab-n':
      if (arg != null && tabs[arg]) switchTab(tabs[arg].id);
      break;
    case 'tab-last':
      if (tabs.length) switchTab(tabs[tabs.length - 1].id);
      break;
    case 'zoom-in':
      applyZoom(currentZoom + 0.5);
      break;
    case 'zoom-out':
      applyZoom(currentZoom - 0.5);
      break;
    case 'zoom-reset':
      applyZoom(0);
      break;
    case 'devtools':
      try {
        t?.wv.openDevTools();
      } catch {
        /* ignore */
      }
      break;
  }
}

api.onShortcut(handleShortcut);
api.onOpenTab(({ url, background }) => createTab(url, { background }));
api.onDownload(renderDownload);
api.onAuthPrompt(showAuthPrompt);
api.onMenuFind(() => openFind());

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
void api.getZoom(partition).then((z) => {
  if (zoomTouched) return;
  currentZoom = z;
  for (const t of tabs) {
    try {
      t.wv.setZoomLevel(z);
    } catch {
      /* not yet attached */
    }
  }
});
createTab(initialUrl);
