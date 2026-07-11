/**
 * Sanitize a model-generated string that will be rendered in the UI (chat-list
 * titles, agent names) or a terminal (the `kai` CLI). A model can emit C0/C1
 * control bytes (NUL, ANSI escapes) or Unicode bidi-override/isolate codepoints
 * that corrupt rendering — ANSI color injection into the terminal, or bidi
 * spoofing of the visible text. Strip them at the single boundary where model
 * output becomes a display string.
 */

// C0 (U+0000-001F) + DEL/C1 (U+007F-009F) control chars, plus the bidi
// override (U+202A-202E) and isolate (U+2066-2069) ranges.
const DISPLAY_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/** Remove control + bidi-override chars from a model-generated display string. */
export function stripDisplayUnsafeChars(value: string): string {
  return value.replace(DISPLAY_UNSAFE_RE, '');
}
