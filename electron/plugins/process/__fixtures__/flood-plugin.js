export function activate(api) {
  api.onAction('flood', () => {
    for (let index = 0; index < 5_100; index += 1) {
      if (process.parentPort) process.parentPort.postMessage({ type: 'fixture-flood', index });
      else api.state.set('flood', index);
    }
    return { ok: true };
  });
}
