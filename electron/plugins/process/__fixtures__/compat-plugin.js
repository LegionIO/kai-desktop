let api;
let unsubscribeConfig;
let unsubscribeEvent;

export async function activate(pluginApi) {
  api = pluginApi;
  const config = api.config.get();
  const pluginData = api.config.getPluginData();
  api.config.setPluginData('activated', true);
  api.state.replace({
    activated: true,
    theme: config.ui?.theme ?? null,
    seed: pluginData.seed ?? null,
    configChanges: 0,
    eventCount: 0,
  });
  api.ui.registerPanelView({ id: 'fixture', title: 'Fixture', visible: true });
  api.browser.open({
    url: 'https://example.test',
    partition: 'persist:fixture',
    cookiePromotion: (cookie) => (cookie.domain.endsWith('example.test') ? { promote: true, ttlDays: 2 } : false),
  });
  await api.http.listen(0, async (request) => ({
    status: 201,
    headers: { 'x-fixture': 'true' },
    body: `${request.method}:${request.url}:${request.body ?? ''}`,
  }));

  unsubscribeConfig = api.config.onChanged(() => {
    api.state.set('configChanges', (api.state.get().configChanges ?? 0) + 1);
  });
  unsubscribeEvent = api.events.on('fixture:event', () => {
    api.state.set('eventCount', (api.state.get().eventCount ?? 0) + 1);
  });

  api.tools.register([
    {
      name: 'fixture_echo',
      description: 'Exercise a plugin callback across the utility-process boundary.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      execute: async (input, context) => {
        context.onProgress?.({
          stream: 'stdout',
          delta: 'progress',
          output: 'progress',
          bytesSeen: 8,
          truncated: false,
          stopped: false,
        });
        return {
          echoed: input.value,
          configChanges: api.state.get().configChanges,
          eventCount: api.state.get().eventCount,
          aborted: context.abortSignal?.aborted ?? false,
        };
      },
    },
    {
      name: 'fixture_wait_abort',
      description: 'Exercise AbortSignal propagation into the utility process.',
      inputSchema: { type: 'object' },
      execute: async (_input, context) => {
        if (context.abortSignal?.aborted) return { aborted: true, reason: context.abortSignal.reason };
        return new Promise((resolve) => {
          const timeout = setTimeout(() => resolve({ aborted: false }), 2_000);
          context.abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timeout);
              resolve({ aborted: true, reason: context.abortSignal.reason });
            },
            { once: true },
          );
        });
      },
    },
  ]);

  api.messages.registerPreSendHook((args) => ({ ...args, systemPrompt: `${args.systemPrompt ?? ''}|fixture` }));
  api.lifecycle.registerPreUpdateHook(({ version }) => ({
    abort: version === 'blocked',
    abortReason: version === 'blocked' ? 'fixture blocked update' : undefined,
  }));
  api.hooks.register('PreToolUse', (payload) => ({ payload: { ...payload, fixture: true } }), { mode: 'modify' });

  api.agent.registerInferenceProvider({
    name: 'Fixture',
    isAvailable: () => true,
    stream: async function* (options) {
      const toolValue = options.tools?.[0]
        ? await options.tools[0].execute({ value: 20 }, { toolCallId: 'provider-tool' }).then((value) => value * 2)
        : null;
      yield { conversationId: options.conversationId, type: 'text-delta', text: 'provider', data: { toolValue } };
      yield { conversationId: options.conversationId, type: 'done' };
    },
  });

  api.onAction('fixture', async (_action, data) => {
    const generateOptions = { messages: [{ role: 'user', content: String(data ?? '') }] };
    if (data === 'abort-test') {
      const controller = new AbortController();
      generateOptions.abortSignal = controller.signal;
      setTimeout(() => controller.abort('utility-abort'), 10);
    }
    const generated = await api.agent.generate(generateOptions);
    let auth = null;
    if (data === 'auth-test') {
      auth = await api.auth.openAuthWindow({
        url: 'https://example.test/auth',
        onReady: async (helpers) => {
          const executed = await helpers.executeJavaScript('21').then((value) => value * 2);
          api.state.set('authExecuted', executed);
          api.state.set('authUrl', helpers.getURL());
          helpers.onDidNavigate((url) => api.state.set('authNavigate', url));
          helpers.hide();
          helpers.show();
        },
      });
    }
    const streamed = [];
    for await (const event of api.agent.stream({ messages: [] })) streamed.push(event.type);
    const cipher = api.safeStorage.encryptString('secret');
    return {
      ok: true,
      data: {
        generated: generated.text,
        streamed,
        decrypted: api.safeStorage.decryptString(cipher),
        auth,
        state: api.state.get(),
      },
    };
  });
}

export function onConfigChanged() {
  api.state.set('moduleConfigChanged', true);
}

export async function deactivate() {
  unsubscribeConfig?.();
  unsubscribeEvent?.();
  await api.http.close();
  api.state.set('deactivated', true);
}
