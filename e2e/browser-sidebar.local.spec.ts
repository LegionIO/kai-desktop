import { createServer, type Server } from 'node:http';
import { test, expect } from '@playwright/test';
import { launchElectronForSmoke, type ElectronHandle } from './electron-launcher';

type BrowserTabResult = {
  id: string;
  url: string;
  owner?: 'user' | 'assistant';
  keepOpen?: boolean;
  discarded?: boolean;
};
type BrowserStateResult = { tabs: BrowserTabResult[]; activeTabId: string | null };
type BrowserIntegrationDriver = {
  beginAssistantRun: (conversationId: string, runId: string) => void;
  createAssistantTab: (conversationId: string, targetUrl: string, runId: string) => Promise<BrowserTabResult>;
  runAssistantAction: (conversationId: string, runId: string, request: Record<string, unknown>) => Promise<unknown>;
  runAssistantInspect: (conversationId: string, runId: string, tabId: string) => Promise<Record<string, unknown>>;
  runAssistantNetwork: (
    conversationId: string,
    runId: string,
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  runAssistantEvaluate: (conversationId: string, runId: string, tabId: string, script: string) => Promise<unknown>;
  runAssistantScreenshot: (
    conversationId: string,
    runId: string,
    request: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  getPresentationState: () => {
    mountedConversationId: string | null;
    chromeFocusConversationId: string | null;
    attached: boolean;
    windowMinimized: boolean;
    windowFocused: boolean;
  };
  isBrowserConfigTransitionPending: () => boolean;
  getTabContentsId: (conversationId: string, tabId: string) => number | null;
  keepAssistantTabOpen: (conversationId: string, tabId: string, runId: string) => Promise<void>;
  endAssistantRun: (conversationId: string, runId: string) => Promise<void>;
};

let handle: ElectronHandle;
let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/basic') {
      if (request.headers.authorization !== `Basic ${Buffer.from('kai:browser').toString('base64')}`) {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Kai browser test"' });
        response.end('authentication required');
        return;
      }
      response.end('<!doctype html><title>Authenticated</title><p id="auth">authenticated</p>');
      return;
    }
    if (path === '/popup') {
      response.end(
        `<!doctype html><title>OAuth popup</title><script>window.opener?.postMessage('oauth-complete','*')</script><p>popup</p>`,
      );
      return;
    }
    if (path === '/cookie') {
      response.end(
        `<!doctype html><title>Cookie check</title><p id="cookie">${request.headers.cookie?.includes('kai_session=ready') ? 'cookie-present' : 'cookie-missing'}</p>`,
      );
      return;
    }
    response.writeHead(200, { 'Set-Cookie': 'kai_session=ready; Path=/; HttpOnly; SameSite=Lax' });
    response.end(`<!doctype html>
      <title>Browser integration</title>
      <style>body{margin:0}.spacer{height:9000px}#capture{width:180px;height:90px;background:#7c3aed;color:white}</style>
      <script>
        document.documentElement.dataset.initialViewport=innerWidth+'x'+innerHeight;
        addEventListener('message',event=>{if(event.data==='oauth-complete')document.body.dataset.oauth='complete'});
        addEventListener('pointerdown',event=>{document.body.dataset.pointerTimestampOffset=String(performance.timeOrigin+event.timeStamp-Date.now())},true);
        addEventListener('keydown',event=>{document.body.dataset.keydownTimestampOffset=String(performance.timeOrigin+event.timeStamp-Date.now())},true);
        addEventListener('input',event=>{document.body.dataset.inputTimestampOffset=String(performance.timeOrigin+event.timeStamp-Date.now())},true);
      </script>
      <input id="field"><button id="button" onclick="document.body.dataset.clicked='yes'">Click</button>
      <button id="popup" onclick="document.body.dataset.popupClicked='yes';window.open('/popup','oauth')">OAuth popup</button>
      <div class="spacer"></div><div id="capture">component</div>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser test server did not bind a TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
  handle = await launchElectronForSmoke({ browserIntegrationTest: true });
});

test.afterAll(async () => {
  if (handle) await handle.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function browserState(conversationId: string): Promise<BrowserStateResult> {
  return handle.page.evaluate(async (id) => {
    const browser = (
      window as unknown as { app: { browser: { getState: (conversationId: string) => Promise<BrowserStateResult> } } }
    ).app.browser;
    return browser.getState(id);
  }, conversationId);
}

async function persistBrowserTestConversation(conversationId: string): Promise<void> {
  await handle.page.evaluate(async (id) => {
    const timestamp = new Date().toISOString();
    await (
      window as unknown as {
        app: { conversations: { put: (conversation: Record<string, unknown>) => Promise<unknown> } };
      }
    ).app.conversations.put({
      id,
      title: null,
      fallbackTitle: id,
      messages: [],
      messageTree: [],
      headId: null,
      conversationCompaction: null,
      lastContextUsage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: null,
      titleStatus: 'idle',
      titleUpdatedAt: null,
      messageCount: 0,
      userMessageCount: 0,
      runStatus: 'idle',
      hasUnread: false,
      lastAssistantUpdateAt: null,
      selectedModelKey: null,
    });
  }, conversationId);
}

async function browserContentsId(fragment: string): Promise<number> {
  const resolveId = () =>
    handle.app.evaluate(({ webContents }, target) => {
      return webContents.getAllWebContents().find((contents) => contents.getURL().includes(target))?.id ?? null;
    }, fragment);
  await expect.poll(resolveId).not.toBeNull();
  const id = await resolveId();
  if (id === null) throw new Error(`No browser webContents matched ${fragment}`);
  return id;
}

async function callIntegrationDriver<T>(operation: keyof BrowserIntegrationDriver, args: unknown[]): Promise<T> {
  return handle.app.evaluate(
    async (_electron, request) => {
      const driver = Reflect.get(globalThis, Symbol.for('kai.browser.integration-driver')) as
        | Record<string, (...values: unknown[]) => unknown>
        | undefined;
      const method = driver?.[request.operation];
      if (!driver || typeof method !== 'function') throw new Error('Browser integration driver was not installed.');
      return (await method.apply(driver, request.args)) as T;
    },
    { operation, args },
  ) as Promise<T>;
}

test('native sidebar browser navigation, input, sessions, popups, screenshots, shortcuts, and cleanup', async () => {
  const conversationId = 'browser-electron-local';
  await persistBrowserTestConversation(conversationId);
  await persistBrowserTestConversation('browser-electron-other-chat');
  await expect(callIntegrationDriver('getPresentationState', [])).resolves.toMatchObject({
    mountedConversationId: null,
    chromeFocusConversationId: null,
    attached: false,
  });
  await expect(
    handle.page.evaluate(() =>
      (window as unknown as { app: { browser: { available: () => Promise<boolean> } } }).app.browser.available(),
    ),
  ).resolves.toBe(true);

  const rejectedRunId = 'browser-integration-private-network';
  await callIntegrationDriver('beginAssistantRun', [conversationId, rejectedRunId]);
  await expect(
    callIntegrationDriver('createAssistantTab', [conversationId, `${origin}/`, rejectedRunId]),
  ).rejects.toThrow(/private-network/);
  await callIntegrationDriver('endAssistantRun', [conversationId, rejectedRunId]);

  const assistantRunId = 'browser-integration-assistant-success';
  await callIntegrationDriver('beginAssistantRun', [conversationId, assistantRunId]);
  const assistantTab = await callIntegrationDriver<BrowserTabResult>('createAssistantTab', [
    conversationId,
    'about:blank',
    assistantRunId,
  ]);
  expect(assistantTab).toMatchObject({ owner: 'assistant', keepOpen: false });
  const beforeAiShortcut = (await browserState(conversationId)).tabs.length;
  await expect(
    callIntegrationDriver('runAssistantAction', [
      conversationId,
      assistantRunId,
      {
        tabId: assistantTab.id,
        kind: 'press',
        keys: ['Control', 'T'],
      },
    ]),
  ).rejects.toThrow(/Browser chrome keyboard shortcuts/);
  expect((await browserState(conversationId)).tabs).toHaveLength(beforeAiShortcut);
  await callIntegrationDriver('endAssistantRun', [conversationId, assistantRunId]);
  await expect
    .poll(async () => (await browserState(conversationId)).tabs.some((entry) => entry.id === assistantTab.id))
    .toBe(false);
  await expect(
    callIntegrationDriver('createAssistantTab', [conversationId, 'about:blank', assistantRunId]),
  ).rejects.toThrow(/ended or is not registered/);

  const keptRunId = 'browser-integration-assistant-kept';
  await callIntegrationDriver('beginAssistantRun', [conversationId, keptRunId]);
  const keptTab = await callIntegrationDriver<BrowserTabResult>('createAssistantTab', [
    conversationId,
    'about:blank',
    keptRunId,
  ]);
  await callIntegrationDriver('keepAssistantTabOpen', [conversationId, keptTab.id, keptRunId]);
  await callIntegrationDriver('endAssistantRun', [conversationId, keptRunId]);
  await expect
    .poll(async () => (await browserState(conversationId)).tabs.find((entry) => entry.id === keptTab.id))
    .toMatchObject({
      id: keptTab.id,
      owner: 'assistant',
      keepOpen: true,
    });

  const tab = await handle.page.evaluate(
    async ({ conversationId: id, url }) => {
      const browser = (
        window as unknown as {
          app: { browser: { createTab: (request: Record<string, unknown>) => Promise<BrowserTabResult> } };
        }
      ).app.browser;
      return browser.createTab({ conversationId: id, url, owner: 'user' });
    },
    { conversationId, url: `${origin}/` },
  );

  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) => {
      const browser = (
        window as unknown as {
          app: { browser: { navigate: (conversationId: string, tabId: string, url: string) => Promise<void> } };
        }
      ).app.browser;
      await browser.navigate(id, tabId, 'about:blank');
    },
    { conversationId, tabId: tab.id },
  );
  const historyRunId = 'browser-integration-private-history';
  await callIntegrationDriver('beginAssistantRun', [conversationId, historyRunId]);
  await expect(
    callIntegrationDriver('runAssistantAction', [conversationId, historyRunId, { tabId: tab.id, kind: 'back' }]),
  ).rejects.toThrow(/private-network/);
  await expect
    .poll(async () => (await browserState(conversationId)).tabs.find((entry) => entry.id === tab.id)?.url)
    .toBe('about:blank');
  await callIntegrationDriver('endAssistantRun', [conversationId, historyRunId]);
  await handle.page.evaluate(async () => {
    await (
      window as unknown as {
        app: { config: { set: (path: string, value: unknown) => Promise<unknown> } };
      }
    ).app.config.set('browser.aiAllowPrivateNetwork', true);
  });
  await expect.poll(() => callIntegrationDriver('isBrowserConfigTransitionPending', [])).toBe(false);
  await expect(callIntegrationDriver('getPresentationState', [])).resolves.toMatchObject({
    mountedConversationId: null,
    chromeFocusConversationId: null,
    attached: false,
  });
  await handle.page.evaluate(
    async ({ conversationId: id, tabId, url }) => {
      const browser = (
        window as unknown as {
          app: { browser: { navigate: (conversationId: string, tabId: string, url: string) => Promise<void> } };
        }
      ).app.browser;
      await browser.navigate(id, tabId, url);
    },
    { conversationId, tabId: tab.id, url: `${origin}/` },
  );

  const contentsId = await browserContentsId(`${origin}/`);
  await handle.page.evaluate(async (id) => {
    await (
      window as unknown as {
        app: { browser: { mount: (conversationId: string, bounds: Record<string, number>) => Promise<void> } };
      }
    ).app.browser.mount(id, { x: 20, y: 100, width: 600, height: 420 });
  }, conversationId);
  await handle.app.evaluate(async ({ webContents }, id) => {
    await webContents.fromId(id)?.executeJavaScript(`document.querySelector('#field').value = ''`);
  }, contentsId);
  await handle.app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error('Browser contents disappeared.');
    const point = (await contents.executeJavaScript(
      `(() => { const r=document.querySelector('#field').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
    )) as { x: number; y: number };
    contents.focus();
    contents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    contents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      x: Math.round(point.x),
      y: Math.round(point.y),
      clickCount: 1,
    });
    contents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      x: Math.round(point.x),
      y: Math.round(point.y),
      clickCount: 1,
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const focused = await contents.executeJavaScript(`document.activeElement?.id === 'field'`);
      if (focused) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const focused = await contents.executeJavaScript(`document.activeElement?.id === 'field'`);
    if (!focused) throw new Error('User click did not focus the browser page input.');
    await contents.insertText('typed by user');
  }, contentsId);
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id)?.executeJavaScript(`document.querySelector('#field').value`),
      contentsId,
    ),
  ).resolves.toBe('typed by user');

  const cookieTab = await handle.page.evaluate(
    async ({ conversationId: id, url }) => {
      const browser = (
        window as unknown as {
          app: { browser: { createTab: (request: Record<string, unknown>) => Promise<BrowserTabResult> } };
        }
      ).app.browser;
      return browser.createTab({ conversationId: id, url, owner: 'user' });
    },
    { conversationId: 'browser-electron-other-chat', url: `${origin}/cookie` },
  );
  const cookieContents = await browserContentsId('/cookie');
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id)?.executeJavaScript(`document.querySelector('#cookie').textContent`),
      cookieContents,
    ),
  ).resolves.toBe('cookie-present');
  expect((await browserState(conversationId)).tabs.some((entry) => entry.id === cookieTab.id)).toBe(false);

  const beforePopupContents = await handle.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((contents) => contents.id),
  );
  // The manager conservatively attributes derived input to the assistant for
  // 1.5 seconds after an automation action. Exercise the user-owned OAuth
  // popup after that bounded provenance handoff, not during the safety grace.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect((await browserState(conversationId)).tabs.find((entry) => entry.id === tab.id)).toMatchObject({
    discarded: false,
  });
  await expect(callIntegrationDriver('getTabContentsId', [conversationId, tab.id])).resolves.toBe(contentsId);
  await handle.app.evaluate(async ({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error('Browser contents disappeared.');
    const point = (await contents.executeJavaScript(
      `(() => { const r=document.querySelector('#popup').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`,
    )) as { x: number; y: number };
    contents.focus();
    contents.sendInputEvent({ type: 'mouseMove', x: Math.round(point.x), y: Math.round(point.y) });
    contents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      x: Math.round(point.x),
      y: Math.round(point.y),
      clickCount: 1,
    });
    contents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      x: Math.round(point.x),
      y: Math.round(point.y),
      clickCount: 1,
    });
  }, contentsId);
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript(`document.body.dataset.popupClicked`),
      contentsId,
    ),
  ).resolves.toBe('yes');
  await expect
    .poll(async () => (await browserState(conversationId)).tabs.some((entry) => entry.url.endsWith('/popup')))
    .toBe(true);
  const popupContentsId = await browserContentsId('/popup');
  const popupTabId = (await browserState(conversationId)).tabs.find((entry) => entry.url.endsWith('/popup'))?.id;
  expect(popupTabId).toBeTruthy();
  const popupContents = await handle.app.evaluate(
    ({ webContents }, existingIds) =>
      webContents
        .getAllWebContents()
        .filter((contents) => !existingIds.includes(contents.id))
        .map((contents) => ({ id: contents.id, url: contents.getURL(), type: contents.getType() })),
    beforePopupContents,
  );
  expect(popupContents).toEqual([{ id: popupContentsId, url: `${origin}/popup`, type: 'window' }]);
  await expect
    .poll(async () =>
      handle.app.evaluate(
        async ({ webContents }, id) => webContents.fromId(id)?.executeJavaScript(`document.body.dataset.oauth`),
        contentsId,
      ),
    )
    .toBe('complete');

  const screenshotDocumentToken = (await browserState(conversationId)).tabs.find(
    (entry) => entry.id === tab.id,
  )?.documentToken;
  if (!screenshotDocumentToken) throw new Error('Browser tab did not expose a current document token.');
  const screenshots = await handle.page.evaluate(
    async ({ conversationId: id, tabId, documentToken }) => {
      const browser = (
        window as unknown as {
          app: {
            browser: {
              screenshot: (
                conversationId: string,
                request: Record<string, unknown>,
              ) => Promise<{ width: number; height: number; dataUrl: string }>;
            };
          };
        }
      ).app.browser;
      return Promise.all([
        browser.screenshot(id, { tabId, documentToken, mode: 'full-page' }),
        browser.screenshot(id, { tabId, documentToken, mode: 'element', selector: '#capture' }),
      ]);
    },
    { conversationId, tabId: tab.id, documentToken: screenshotDocumentToken },
  );
  expect(screenshots[0].height).toBeGreaterThan(8_000);
  expect(screenshots[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  expect(screenshots[1]).toMatchObject({ width: 180, height: 90 });
  expect(screenshots[1].dataUrl).toMatch(/^data:image\/png;base64,/);
  const elementPixels = await handle.app.evaluate(({ nativeImage }, dataUrl) => {
    const image = nativeImage.createFromDataURL(dataUrl);
    const bitmap = image.toBitmap();
    let hasPurplePagePixel = false;
    for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      const alpha = bitmap[offset + 3];
      if (alpha > 0 && blue > 150 && green < 130 && red > 60) {
        hasPurplePagePixel = true;
        break;
      }
    }
    return { empty: image.isEmpty(), byteLength: bitmap.length, hasPurplePagePixel };
  }, screenshots[1].dataUrl);
  expect(elementPixels).toMatchObject({ empty: false, hasPurplePagePixel: true });
  expect(elementPixels.byteLength).toBeGreaterThan(180 * 90);

  const beforeShortcut = (await browserState(conversationId)).tabs.length;
  await handle.app.evaluate(({ webContents }, id) => {
    const contents = webContents.fromId(id);
    if (!contents) throw new Error('Browser contents disappeared.');
    const modifiers = process.platform === 'darwin' ? (['meta'] as const) : (['control'] as const);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: [...modifiers] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: [...modifiers] });
  }, contentsId);
  await expect.poll(async () => (await browserState(conversationId)).tabs.length).toBe(beforeShortcut + 1);

  await handle.page.evaluate(
    async ({ conversationId: id, url }) => {
      const browser = (
        window as unknown as {
          app: {
            browser: {
              onEvent: (callback: (event: { type: string; prompt?: { id: string } }) => void) => () => void;
              respondAuthPrompt: (promptId: string, username?: string, password?: string) => Promise<void>;
              createTab: (request: Record<string, unknown>) => Promise<BrowserTabResult>;
            };
          };
        }
      ).app.browser;
      const unsubscribe = browser.onEvent((event) => {
        if (event.type === 'auth-prompt' && event.prompt)
          void browser.respondAuthPrompt(event.prompt.id, 'kai', 'browser');
      });
      try {
        await browser.createTab({ conversationId: id, url, owner: 'user' });
      } finally {
        unsubscribe();
      }
    },
    { conversationId, url: `${origin}/basic` },
  );
  const authContents = await browserContentsId('/basic');
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents.fromId(id)?.executeJavaScript(`document.querySelector('#auth').textContent`),
      authContents,
    ),
  ).resolves.toBe('authenticated');

  const activeSentinelTab = await handle.page.evaluate(
    async ({ conversationId: id, url }) =>
      (
        window as unknown as {
          app: { browser: { createTab: (request: Record<string, unknown>) => Promise<BrowserTabResult> } };
        }
      ).app.browser.createTab({ conversationId: id, url, owner: 'user' }),
    { conversationId, url: `${origin}/?active-sentinel=1` },
  );
  const activeSentinelContentsId = await browserContentsId('active-sentinel=1');
  await expect.poll(async () => (await browserState(conversationId)).activeTabId).toBe(activeSentinelTab.id);

  const backgroundRunId = 'browser-integration-headless-actions';
  await callIntegrationDriver('beginAssistantRun', [conversationId, backgroundRunId]);
  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) => {
      await (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser.commandTab(id, tabId, 'activate');
    },
    { conversationId, tabId: tab.id },
  );
  await expect.poll(async () => (await browserState(conversationId)).activeTabId).toBe(tab.id);
  await handle.app.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      ?.executeJavaScript(
        `(() => { const field=document.querySelector('#field'); field.focus(); field.setSelectionRange(field.value.length,field.value.length); })()`,
      );
  }, contentsId);
  await callIntegrationDriver('runAssistantAction', [
    conversationId,
    backgroundRunId,
    { tabId: tab.id, kind: 'type', selector: '#field', value: 'V' },
  ]);
  const presentedInputState = await handle.app.evaluate(
    async ({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript(
        `({
          value: document.querySelector('#field').value,
          keydownTimestampOffset: Number(document.body.dataset.keydownTimestampOffset),
        })`,
      ),
    contentsId,
  );
  expect(presentedInputState?.value).toBe('typed by userV');
  expect(Math.abs(presentedInputState?.keydownTimestampOffset ?? Number.POSITIVE_INFINITY)).toBeLessThan(2_000);
  await handle.app.evaluate(async ({ webContents }, id) => {
    await webContents
      .fromId(id)
      ?.executeJavaScript(
        `(() => { document.querySelector('#field').value='typed by user'; delete document.body.dataset.keydownTimestampOffset; delete document.body.dataset.inputTimestampOffset; })()`,
      );
  }, contentsId);
  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) => {
      await (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser.commandTab(id, tabId, 'activate');
    },
    { conversationId, tabId: activeSentinelTab.id },
  );
  await expect.poll(async () => (await browserState(conversationId)).activeTabId).toBe(activeSentinelTab.id);

  // Change chats through the real renderer path, then minimize Kai. Every
  // assistant operation below must remain independent of BrowserPanel mount,
  // selected chat/tab, main-window visibility, and OS focus.
  const otherChatButton = handle.page.getByRole('button', { name: /browser-electron-other-chat/i }).first();
  await expect(otherChatButton).toBeVisible();
  await otherChatButton.click();
  await expect(
    handle.page.evaluate(() =>
      (
        window as unknown as {
          app: { conversations: { getActiveId: () => Promise<string | null> } };
        }
      ).app.conversations.getActiveId(),
    ),
  ).resolves.toBe('browser-electron-other-chat');
  await handle.page.evaluate(async (id) => {
    const browser = (
      window as unknown as {
        app: {
          browser: {
            mount: (conversationId: string, bounds: null) => Promise<void>;
            setChromeFocus: (conversationId: string, focused: boolean) => Promise<void>;
          };
        };
      }
    ).app.browser;
    await browser.setChromeFocus(id, false);
    await browser.mount(id, null);
  }, conversationId);
  await handle.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Kai window disappeared.');
    window.minimize();
  });
  await expect.poll(async () => (await callIntegrationDriver('getPresentationState', [])).windowMinimized).toBe(true);
  await expect(callIntegrationDriver('getPresentationState', [])).resolves.toMatchObject({
    mountedConversationId: null,
    chromeFocusConversationId: null,
    attached: false,
    windowMinimized: true,
    windowFocused: false,
  });

  const hiddenCreatedTab = await callIntegrationDriver<BrowserTabResult>('createAssistantTab', [
    conversationId,
    `${origin}/?created-while-minimized=1`,
    backgroundRunId,
  ]);
  const hiddenCreatedContentsId = await callIntegrationDriver<number | null>('getTabContentsId', [
    conversationId,
    hiddenCreatedTab.id,
  ]);
  if (hiddenCreatedContentsId === null) throw new Error('Hidden assistant tab did not retain a live renderer.');
  await expect.poll(async () => (await browserState(conversationId)).activeTabId).toBe(activeSentinelTab.id);
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          ?.executeJavaScript(
            `({ readyState: document.readyState, initialViewport: document.documentElement.dataset.initialViewport })`,
          ),
      hiddenCreatedContentsId,
    ),
  ).resolves.toEqual({ readyState: 'complete', initialViewport: '1280x800' });

  await callIntegrationDriver('runAssistantAction', [
    conversationId,
    backgroundRunId,
    { tabId: hiddenCreatedTab.id, kind: 'click', selector: '#button' },
  ]);
  await callIntegrationDriver('runAssistantAction', [
    conversationId,
    backgroundRunId,
    { tabId: tab.id, kind: 'click', selector: '#button' },
  ]);
  await callIntegrationDriver('runAssistantAction', [
    conversationId,
    backgroundRunId,
    { tabId: tab.id, kind: 'type', selector: '#field', value: 'typed by AI while hidden' },
  ]);
  await expect.poll(async () => (await browserState(conversationId)).activeTabId).toBe(activeSentinelTab.id);
  await expect(
    callIntegrationDriver<Record<string, unknown>>('runAssistantInspect', [
      conversationId,
      backgroundRunId,
      hiddenCreatedTab.id,
    ]),
  ).resolves.toMatchObject({ tabId: hiddenCreatedTab.id, title: 'Browser integration' });
  await expect(
    callIntegrationDriver<Record<string, unknown>>('runAssistantNetwork', [
      conversationId,
      backgroundRunId,
      { tabId: hiddenCreatedTab.id, waitFor: 'network-idle', timeoutMs: 5_000 },
    ]),
  ).resolves.toMatchObject({ tabId: hiddenCreatedTab.id, waitFor: 'network-idle', loading: false });
  await expect(
    callIntegrationDriver<Record<string, unknown>>('runAssistantScreenshot', [
      conversationId,
      backgroundRunId,
      { tabId: hiddenCreatedTab.id, mode: 'viewport' },
    ]),
  ).resolves.toMatchObject({
    tabId: hiddenCreatedTab.id,
    mode: 'viewport',
    width: 1_280,
    height: 800,
    dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
  });
  await expect(
    callIntegrationDriver('runAssistantEvaluate', [
      conversationId,
      backgroundRunId,
      hiddenCreatedTab.id,
      `(() => { document.body.dataset.evaluated = 'yes'; return document.body.dataset.evaluated; })()`,
    ]),
  ).resolves.toBe('yes');
  const backgroundInputState = await handle.app.evaluate(
    async ({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript(
        `({
          clicked: document.body.dataset.clicked,
          value: document.querySelector('#field').value,
          pointerTimestampOffset: Number(document.body.dataset.pointerTimestampOffset),
          inputTimestampOffset: Number(document.body.dataset.inputTimestampOffset),
        })`,
      ),
    contentsId,
  );
  expect(backgroundInputState).toMatchObject({
    clicked: 'yes',
    value: 'typed by usertyped by AI while hidden',
  });
  expect(Math.abs(backgroundInputState?.pointerTimestampOffset ?? Number.POSITIVE_INFINITY)).toBeLessThan(5_000);
  // Bulk Input.insertText has no CDP timestamp field. This path is allowed only
  // while the exact view is detached and quarantined from physical input.
  expect(Math.abs(backgroundInputState?.inputTimestampOffset ?? Number.POSITIVE_INFINITY)).toBeLessThan(5_000);
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          ?.executeJavaScript(
            `({ clicked: document.body.dataset.clicked, evaluated: document.body.dataset.evaluated })`,
          ),
      hiddenCreatedContentsId,
    ),
  ).resolves.toEqual({ clicked: 'yes', evaluated: 'yes' });
  await expect(
    handle.app.evaluate(
      async ({ webContents }, id) =>
        webContents
          .fromId(id)
          ?.executeJavaScript(
            `({ clicked: document.body.dataset.clicked || null, value: document.querySelector('#field').value })`,
          ),
      activeSentinelContentsId,
    ),
  ).resolves.toEqual({ clicked: null, value: '' });
  await expect(callIntegrationDriver('getPresentationState', [])).resolves.toMatchObject({
    mountedConversationId: null,
    chromeFocusConversationId: null,
    attached: false,
    windowMinimized: true,
    windowFocused: false,
  });
  await callIntegrationDriver('endAssistantRun', [conversationId, backgroundRunId]);
  await handle.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
  await expect.poll(async () => (await callIntegrationDriver('getPresentationState', [])).windowMinimized).toBe(false);

  const openTabs = await browserState(conversationId);
  expect(openTabs.tabs.some((entry) => entry.url.endsWith('/popup'))).toBe(true);
  await handle.page.evaluate(
    async ({ conversationId: id, tabIds }) => {
      const browser = (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser;
      for (const tabId of tabIds) await browser.commandTab(id, tabId, 'close');
    },
    { conversationId, tabIds: openTabs.tabs.filter((entry) => entry.id !== popupTabId).map((entry) => entry.id) },
  );
  await expect
    .poll(async () => (await browserState(conversationId)).tabs.map((entry) => entry.id))
    .toEqual([popupTabId!]);
  await expect(
    handle.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), popupContentsId),
  ).resolves.toBe(`${origin}/popup`);
  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) => {
      await (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser.commandTab(id, tabId, 'close');
    },
    { conversationId, tabId: popupTabId! },
  );
  await expect.poll(async () => (await browserState(conversationId)).tabs.length).toBe(0);
  await expect
    .poll(async () =>
      handle.app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        return contents ? { url: contents.getURL(), destroyed: contents.isDestroyed() } : null;
      }, popupContentsId),
    )
    .toBeNull();
  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) => {
      const browser = (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser;
      await browser.commandTab(id, tabId, 'close');
    },
    { conversationId: 'browser-electron-other-chat', tabId: cookieTab.id },
  );
  await expect
    .poll(async () =>
      handle.app.evaluate(
        ({ webContents }, target) =>
          webContents
            .getAllWebContents()
            .map((contents) => contents.getURL())
            .filter((url) => url.startsWith(target)),
        origin,
      ),
    )
    .toEqual([]);
});

test('host renderer reload reclaims native page views and preserves discarded tab shells', async () => {
  const conversationId = 'browser-host-renderer-reload';
  await persistBrowserTestConversation(conversationId);
  const tab = await handle.page.evaluate(
    async ({ conversationId: id, url }) =>
      (
        window as unknown as {
          app: { browser: { createTab: (request: Record<string, unknown>) => Promise<BrowserTabResult> } };
        }
      ).app.browser.createTab({ conversationId: id, url, owner: 'user' }),
    { conversationId, url: `${origin}/?host-renderer-reload=1` },
  );
  const contentsId = await browserContentsId('host-renderer-reload=1');

  await handle.page.reload({ waitUntil: 'domcontentloaded' });
  await expect
    .poll(async () =>
      handle.app.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        return contents ? { destroyed: contents.isDestroyed(), url: contents.getURL() } : null;
      }, contentsId),
    )
    .toBeNull();
  await expect
    .poll(async () => browserState(conversationId))
    .toMatchObject({
      tabs: [{ id: tab.id, discarded: true }],
    });

  await handle.page.evaluate(
    async ({ conversationId: id, tabId }) =>
      (
        window as unknown as {
          app: { browser: { commandTab: (conversationId: string, tabId: string, command: string) => Promise<void> } };
        }
      ).app.browser.commandTab(id, tabId, 'close'),
    { conversationId, tabId: tab.id },
  );
  await expect.poll(async () => (await browserState(conversationId)).tabs).toEqual([]);
});
