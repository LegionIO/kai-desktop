await new Promise((resolve) => setTimeout(resolve, 5));

let activatedName = null;

export async function activate(api) {
  activatedName = api.pluginName;
  const data = api.config.getPluginData();

  api.events.declare({
    name: 'sea-proof:activated',
    description: 'Emitted by the Node SEA plugin-host feasibility fixture.',
  });
  api.ui.registerSettingsView({ id: 'sea-proof', label: 'SEA Proof' });
  api.state.set('answer', data.seed * 6);
  api.onAction('sea-proof', async (action, payload) => ({
    action,
    pluginName: api.pluginName,
    value: payload.value + data.seed,
  }));
  api.log.info('SEA fixture activated', { pluginName: api.pluginName });
}

export async function deactivate() {
  if (!activatedName) throw new Error('SEA fixture deactivated before activation');
  activatedName = null;
}
