export function activate(api) {
  api.onAction('crash', () => {
    setImmediate(() => process.exit(23));
    return { ok: true };
  });
}
