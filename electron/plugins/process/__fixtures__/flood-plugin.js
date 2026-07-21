export function activate(api) {
  api.onAction('flood', () => {
    for (let index = 0; index < 5_100; index += 1) {
      process.parentPort.postMessage({ type: 'fixture-flood', index });
    }
    return { ok: true };
  });
}
