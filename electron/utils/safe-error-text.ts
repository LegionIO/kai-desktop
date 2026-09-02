/**
 * Format an unknown thrown value as a string that CANNOT itself throw.
 *
 * A `catch (err)` block that does `String(err)` (or a template `${err}`) will
 * itself throw if `err` is an object whose `toString` / `Symbol.toPrimitive`
 * throws — which arbitrary plugin code can construct. When that second throw
 * escapes a catch block that runs *after* a guard flag was set (e.g. the
 * auto-updater's `installInProgress`), the guard is never cleared and the app
 * is left wedged. Routing every catch-site error stringification through this
 * helper removes that footgun: it tries the useful representations and falls
 * back to a safe constant if every attempt throws.
 */
export function safeErrorText(err: unknown): string {
  try {
    // Coerce EVERY selected field with String(...) inside the guard: an Error
    // subclass can carry a `message`/`name` that is a Symbol or an object whose
    // toString throws, so returning `err.message` unwrapped would still throw on
    // later interpolation — defeating the whole purpose. String() here keeps the
    // throw inside this try, where the catch turns it into the safe fallback.
    if (err instanceof Error) return String(err.message || err.name || 'Error');
    return String(err);
  } catch {
    return '(unprintable error)';
  }
}
