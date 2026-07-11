/**
 * Tests for the CLI markdown renderer (electron/cli/render/markdown.ts). The
 * input is MODEL-CONTROLLED text rendered to a TTY, so the security-critical
 * behaviors are: stripControl removes every raw terminal escape before we add
 * our own ANSI, and osc8Link only ever links http(s) URLs. The rest is
 * cosmetic markdown → ANSI transformation.
 */
import { describe, it, expect } from 'vitest';
import { stripControl, osc8Link, renderMarkdown } from '../markdown.js';

const ESC = '\x1b';

describe('stripControl', () => {
  it('removes ESC so a color sequence is defanged (only the ESC byte is stripped)', () => {
    // "a\x1b[31mred\x1b[0m" → the two ESC bytes vanish, leaving inert text.
    expect(stripControl(`a${ESC}[31mred${ESC}[0m`)).toBe('a[31mred[0m');
  });

  it('strips the raw ESC byte so no escape sequence survives', () => {
    const out = stripControl(`before${ESC}[2J${ESC}]0;title\x07after`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('\x07'); // BEL (C0) stripped too
    // The letters remain (only the control bytes are removed).
    expect(out.startsWith('before')).toBe(true);
    expect(out.endsWith('after')).toBe(true);
  });

  it('keeps tab and newline but removes other C0 controls', () => {
    expect(stripControl('a\tb\nc\rd\x00e\x08f')).toBe('a\tb\ncdef');
  });

  it('removes the C1 range (0x80-0x9f) where 8-bit CSI/OSC live', () => {
    expect(stripControl('x\x9bmy\x9dz')).toBe('xmyz');
  });

  it('removes DEL (0x7f)', () => {
    expect(stripControl('a\x7fb')).toBe('ab');
  });

  it('preserves ordinary printable + unicode text', () => {
    expect(stripControl('Hello, 世界! 🚀 #hash')).toBe('Hello, 世界! 🚀 #hash');
  });
});

describe('osc8Link', () => {
  it('wraps an http(s) URL in an OSC-8 hyperlink sequence', () => {
    const out = osc8Link('click', 'https://example.com');
    expect(out).toBe(`${ESC}]8;;https://example.com${ESC}\\click${ESC}]8;;${ESC}\\`);
  });

  it('accepts http as well as https', () => {
    expect(osc8Link('l', 'http://x.io')).toContain('http://x.io');
  });

  it('returns the plain (stripped) label for a non-http scheme', () => {
    // javascript:, file:, data:, mailto:, relative — none become links.
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'mailto:a@b.c', '/rel/path']) {
      expect(osc8Link('label', url)).toBe('label');
    }
  });

  it('strips control chars from the label even when linked', () => {
    const out = osc8Link(`lab${ESC}[31mel`, 'https://x.io');
    expect(out).not.toContain(`${ESC}[31m`);
    // Only the ESC byte is removed → "lab[31mel" remains as inert text.
    expect(out).toContain('lab[31mel');
  });

  it('cannot smuggle an escape through a would-be http URL (stripped before use)', () => {
    // Even though SAFE_URL matches the https prefix, stripControl removes the ESC
    // so the injected sequence never reaches the terminal.
    const out = osc8Link('x', `https://evil${ESC}]0;pwn\x07`);
    expect(out).not.toContain(ESC + ']0;'); // no injected OSC title-set
    // The only ESC bytes present are the OSC-8 framing we added ourselves.
  });
});

describe('renderMarkdown', () => {
  it('strips model-emitted raw escapes from the input before adding ANSI', () => {
    const out = renderMarkdown(`plain ${ESC}[2Jtext`);
    // The injected clear-screen CSI is gone; our own ANSI framing may add ESC,
    // but the attacker's \x1b[2J must not appear.
    expect(out).not.toContain(`${ESC}[2J`);
  });

  it('renders a heading as bold cyan', () => {
    const out = renderMarkdown('# Title');
    expect(out).toContain('Title');
    expect(out).toContain('\x1b[1m'); // BOLD
    expect(out).toContain('\x1b[36m'); // CYAN
  });

  it('renders a bullet with a • marker', () => {
    expect(renderMarkdown('- item')).toContain('•');
  });

  it('wraps a fenced code block in a dim gutter', () => {
    const out = renderMarkdown('```\ncode line\n```');
    expect(out).toContain('│'); // gutter
    expect(out).toContain('code line');
  });

  it('flushes an unterminated fence (renders what it has)', () => {
    const out = renderMarkdown('```js\nconst x = 1;');
    expect(out).toContain('const x = 1;');
    expect(out).toContain('│');
  });

  it('turns a [label](url) link into an OSC-8 link for http(s)', () => {
    const out = renderMarkdown('see [docs](https://example.com) here');
    expect(out).toContain(`${ESC}]8;;https://example.com`);
    expect(out).toContain('docs');
  });

  it('renders a [label](url) with a dangerous scheme as plain label (no link)', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain(']8;;javascript'); // never linked
    expect(out).toContain('click');
  });

  it('applies inline code, bold, and italic', () => {
    expect(renderMarkdown('`code`')).toContain('\x1b[36m'); // CYAN inline code
    expect(renderMarkdown('**b**')).toContain('\x1b[1m'); // BOLD
    expect(renderMarkdown('*i*')).toContain('\x1b[3m'); // ITALIC
    expect(renderMarkdown('_i_')).toContain('\x1b[3m');
  });

  it('linkifies a bare http URL', () => {
    const out = renderMarkdown('visit https://example.com now');
    expect(out).toContain(`${ESC}]8;;https://example.com`);
  });

  it('does not hang on a pathological unmatched-bracket input (ReDoS guard)', () => {
    // The link regex label/url quantifiers are bounded so a degenerate model
    // output of repeated "[" cannot trigger quadratic backtracking. Unbounded,
    // 80k chars took ~2.7s; bounded it is tens of ms. Assert it completes fast.
    const evil = '['.repeat(80_000);
    const start = performance.now();
    renderMarkdown(evil);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('leaves an absurdly long link label unlinked but intact', () => {
    const longLabel = 'a'.repeat(600);
    const out = renderMarkdown(`[${longLabel}](https://x.io)`);
    expect(out).not.toContain(`${ESC}]8;;`); // over the 500-char bound → not linked
    expect(out).toContain(longLabel);
  });
});
