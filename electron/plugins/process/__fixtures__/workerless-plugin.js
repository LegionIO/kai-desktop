let api;
let unsubscribeConfig;

export function activate(pluginApi) {
  api = pluginApi;
  const initial = api.config.getPluginData();
  api.config.setPluginData('workerlessCount', Number(initial.seed ?? 0) + 1);
  api.config.set('ui.theme', 'light');
  api.state.set('workerlessActivated', true);
  api.events.declare({ events: [{ event: 'ready', description: 'Workerless fixture ready' }] });
  api.ui.registerSettingsView({ id: 'workerless', label: 'Workerless' });
  api.ui.showModal({ id: 'workerless', title: 'Workerless', visible: true });
  api.ui.updateModal('workerless', { title: 'Workerless ready' });
  api.ui.hideModal('workerless');
  unsubscribeConfig = api.config.onChanged(() => api.state.set('workerlessConfigChanged', true));
  api.onAction('workerless', () => ({
    ok: true,
    data: {
      theme: api.config.get().ui?.theme,
      count: api.config.getPluginData().workerlessCount,
    },
  }));
}

export function deactivate() {
  unsubscribeConfig?.();
  api.state.set('workerlessDeactivated', true);
}
