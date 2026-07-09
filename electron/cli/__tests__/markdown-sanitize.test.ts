/**
 * Terminal-output sanitization: model-controlled text must not be able to
 * inject ANSI/OSC escapes, and clickable links must only use safe schemes.
 */
import { describe, it, expect } from 'vitest';
import { stripControl, osc8Link, renderMarkdown } from '../render/markdown.js';

describe('stripControl', () => {
  it('removes ESC and C0 control chars but keeps tab/newline', () => {
    const dirty = 'a\x1b[31mred\x1b[0m\tb\nc\x07\x00';
    const clean = stripControl(dirty);
    expect(clean).not.toContain('\x1b');
    expect(clean).not.toContain('\x07');
    expect(clean).not.toContain('\x00');
    expect(clean).toContain('\t');
    expect(clean).toContain('\n');
    expect(clean).toContain('red');
  });
});

describe('osc8Link', () => {
  it('makes http(s) links clickable', () => {
    const out = osc8Link('click', 'https://example.com');
    expect(out).toContain('https://example.com');
    expect(out).toContain('\x1b]8;;');
  });

  it('does NOT linkify dangerous schemes — returns plain text', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      const out = osc8Link('x', url);
      expect(out).toBe('x'); // plain label, no OSC-8 escape
      expect(out).not.toContain('\x1b]8;;');
    }
  });

  it('strips control chars from label and url', () => {
    const out = osc8Link('la\x1bbel', 'https://ex\x1bample.com');
    // ESC only appears as the OSC-8 framing we add (]8;; ... \\), never from
    // the model's label/url content.
    expect(out).toContain('\x1b]8;;https://example.com');
    expect(out).toContain('label');
    expect(out).not.toContain('ex\x1bample');
  });
});

describe('renderMarkdown sanitization', () => {
  it('strips raw escapes from model text before formatting', () => {
    const out = renderMarkdown('hello \x1b[2J\x1b[31mworld');
    expect(out).not.toContain('\x1b[2J'); // clear-screen injection removed
    expect(out).toContain('hello');
    expect(out).toContain('world');
  });
});
