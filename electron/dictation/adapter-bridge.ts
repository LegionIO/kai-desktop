import type { LocalMacosHelperResponse } from '../computer-use/permissions.js';
import { getFallbackAdapter, getPlatformAdapter } from '../platform/index.js';
import type { NativePlatformAdapter } from '../platform/types.js';

/**
 * Translate the macOS Swift-helper command vocabulary used by the dictation
 * manager into `NativePlatformAdapter` calls so the existing dictation code
 * runs unchanged on Windows (UIA), Linux (AT-SPI), and the nut-js fallback.
 *
 * Returns `null` for commands that have no cross-platform equivalent so the
 * caller can fall through to its existing degraded-keyboard path.
 */
export async function runDictationViaAdapter(args: string[]): Promise<LocalMacosHelperResponse | null> {
  const [cmd, ...rest] = args;
  const adapter = await getPlatformAdapter();

  switch (cmd) {
    case 'permissions': {
      const perms = await adapter.checkPermissions();
      return {
        ok: perms.helperReady,
        accessibilityTrusted: perms.helperReady,
        screenRecordingGranted: true,
        automationGranted: true,
        inputMonitoringGranted: true,
      };
    }

    case 'focusedTextSelection': {
      const snap = await adapter.readFocusedTextField();
      if (!snap) return { ok: false, error: 'no focused text field' };
      return {
        ok: true,
        selectedTextRangeLocation: snap.selectionStart,
        selectedTextRangeLength: snap.selectionEnd - snap.selectionStart,
        elementSignature: snap.elementSignature,
      };
    }

    case 'focusedTextRangeState': {
      const location = Number.parseInt(rest[0] ?? '', 10);
      const length = Number.parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(location) || !Number.isInteger(length) || location < 0 || length < 0) {
        return { ok: false, error: 'invalid range arguments' };
      }
      const snap = await adapter.readFocusedTextField();
      if (!snap) return { ok: false, error: 'no focused text field' };
      if (location + length > snap.value.length) {
        return { ok: false, error: 'range exceeds field length' };
      }
      const rangeText = snap.value.slice(location, location + length);
      return {
        ok: true,
        selectedTextRangeLocation: snap.selectionStart,
        selectedTextRangeLength: snap.selectionEnd - snap.selectionStart,
        elementSignature: snap.elementSignature,
        rangeText,
        textUtf16Length: snap.value.length,
      };
    }

    case 'replaceTextAtomically':
    case 'replaceTextRangeVerified': {
      const location = Number.parseInt(rest[0] ?? '', 10);
      const length = Number.parseInt(rest[1] ?? '', 10);
      const text = decodeBase64(rest[2]);
      const expectedSignature = rest[4] ? decodeBase64(rest[4]) : null;
      if (!Number.isInteger(location) || !Number.isInteger(length) || location < 0 || length < 0) {
        return { ok: false, error: 'invalid range arguments' };
      }
      const snap = await adapter.readFocusedTextField();
      if (!snap) return { ok: false, error: 'no focused text field' };
      if (expectedSignature && snap.elementSignature !== expectedSignature) {
        return { ok: false, error: 'element signature mismatch' };
      }
      if (location + length > snap.value.length) {
        return { ok: false, error: 'range exceeds field length' };
      }
      const spliced = snap.value.slice(0, location) + text + snap.value.slice(location + length);
      const caret = location + text.length;
      const ok = await adapter.writeFocusedTextField(spliced, caret, caret);
      return {
        ok,
        method: 'value',
        cursorSet: ok,
        cursorPosition: caret,
        textUtf16Length: text.length,
      };
    }

    case 'postText': {
      const text = decodeBase64(rest[0]);
      try {
        await typeWithFallback(adapter, text);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true };
    }

    case 'deleteBack': {
      const count = Math.max(1, parseInt(rest[0] ?? '1', 10) || 1);
      try {
        for (let i = 0; i < count; i++) {
          await pressWithFallback(adapter, ['backspace']);
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true };
    }

    case 'applyTextPatch': {
      const ops = decodePatchOperations(rest[0]);
      if (!ops) return { ok: false, error: 'invalid applyTextPatch payload' };
      try {
        for (const op of ops) {
          if (op.kind === 'insertText') {
            if (op.text) await typeWithFallback(adapter, op.text);
          } else {
            const key = op.kind === 'moveLeft' ? 'left' : op.kind === 'moveRight' ? 'right' : 'delete';
            const count = Math.max(0, Math.min(op.count, 512));
            for (let i = 0; i < count; i++) {
              await pressWithFallback(adapter, [key]);
            }
          }
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true };
    }

    default:
      return null;
  }
}

export async function clipboardPaste(text: string): Promise<void> {
  const { clipboard } = await import('electron');
  const adapter = await getPlatformAdapter();

  const savedText = clipboard.readText();
  const savedHtml = clipboard.readHTML();
  const savedRtf = clipboard.readRTF();
  const savedImage = clipboard.readImage();
  const savedBookmark = (() => {
    try {
      return clipboard.readBookmark();
    } catch {
      return null;
    }
  })();

  clipboard.writeText(text);
  try {
    const modifier = process.platform === 'darwin' ? 'command' : 'control';
    await pressWithFallback(adapter, [modifier, 'v']);
    await new Promise((resolve) => setTimeout(resolve, 60));
  } finally {
    const restore: Electron.Data = {};
    if (savedText) restore.text = savedText;
    if (savedHtml) restore.html = savedHtml;
    if (savedRtf) restore.rtf = savedRtf;
    if (!savedImage.isEmpty()) restore.image = savedImage;
    if (savedBookmark?.url) restore.bookmark = savedBookmark.url;
    if (Object.keys(restore).length > 0) {
      clipboard.write(restore);
    } else {
      clipboard.clear();
    }
  }
}

async function typeWithFallback(adapter: NativePlatformAdapter, text: string): Promise<void> {
  try {
    await adapter.typeText(text);
    return;
  } catch {
    /* try fallback */
  }
  try {
    await getFallbackAdapter().typeText(text);
    return;
  } catch {
    /* try clipboard */
  }
  await clipboardPaste(text);
}

async function pressWithFallback(adapter: NativePlatformAdapter, keys: string[]): Promise<void> {
  try {
    await adapter.pressKeys(keys);
    return;
  } catch {
    /* try fallback */
  }
  await getFallbackAdapter().pressKeys(keys);
}

function decodeBase64(value: string | undefined): string {
  if (!value) return '';
  try {
    return Buffer.from(value, 'base64').toString('utf-8');
  } catch {
    return '';
  }
}

type PatchOperation =
  | { kind: 'moveLeft' | 'moveRight' | 'deleteForward'; count: number }
  | { kind: 'insertText'; text: string };

function decodePatchOperations(encoded: string | undefined): PatchOperation[] | null {
  const json = decodeBase64(encoded);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const ops: PatchOperation[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    if (kind === 'insertText') {
      const text = (item as { text?: unknown }).text;
      ops.push({ kind: 'insertText', text: typeof text === 'string' ? text : '' });
    } else if (kind === 'moveLeft' || kind === 'moveRight' || kind === 'deleteForward') {
      const count = (item as { count?: unknown }).count;
      ops.push({
        kind,
        count: typeof count === 'number' && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
      });
    }
  }
  return ops;
}
