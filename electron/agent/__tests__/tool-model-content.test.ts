import { describe, it, expect, afterEach } from 'vitest';
import {
  extractModelContent,
  buildMcpToolContent,
  applyMediaLimits,
  getMaxPartBytes,
  getMaxTotalBytes,
} from '../tool-model-content.js';

describe('extractModelContent', () => {
  it('passes through results without _modelContent', () => {
    const r = { success: true, foo: 'bar' };
    const { modelContent, cleaned } = extractModelContent(r);
    expect(modelContent).toBeNull();
    expect(cleaned).toBe(r);
  });

  it('strips _modelContent from the cleaned result and returns parts', () => {
    const result = {
      success: true,
      name: 'shot.png',
      _modelContent: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }],
    };
    const { modelContent, cleaned } = extractModelContent(result);
    expect(modelContent).toEqual([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }]);
    expect(cleaned).toEqual({ success: true, name: 'shot.png' });
    expect((cleaned as Record<string, unknown>)._modelContent).toBeUndefined();
  });

  it('drops oversized images with a text note', () => {
    const bigBase64 = 'A'.repeat(8 * 1024 * 1024); // ~6 MB decoded, over the 5 MB cap
    const { modelContent } = extractModelContent({
      _modelContent: [{ type: 'image', data: bigBase64, mediaType: 'image/png' }],
    });
    expect(modelContent).toHaveLength(1);
    expect(modelContent![0].type).toBe('text');
    expect((modelContent![0] as { text: string }).text).toContain('omitted');
  });

  it('ignores malformed parts', () => {
    const { modelContent } = extractModelContent({
      _modelContent: [
        { type: 'image' }, // no data
        { type: 'text', text: 'ok' },
        42,
      ],
    });
    expect(modelContent).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('strips an accidental data: URL prefix and keeps bare base64', () => {
    const { modelContent } = extractModelContent({
      _modelContent: [{ type: 'image', data: 'data:image/png;base64,AAAA', mediaType: 'image/png' }],
    });
    expect(modelContent).toEqual([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }]);
  });

  it('adopts the mediaType from a data: URL when the caller left it generic', () => {
    const { modelContent } = extractModelContent({
      _modelContent: [
        { type: 'file', data: 'data:application/pdf;base64,JVBERi0=', mediaType: 'application/octet-stream' },
      ],
    });
    expect(modelContent).toEqual([{ type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' }]);
  });

  it('measures the decoded payload after stripping the prefix', () => {
    // Payload is small; only the (large) prefix would push it over — but the
    // prefix must not count toward the size cap.
    const { modelContent } = extractModelContent({
      _modelContent: [{ type: 'image', data: 'data:image/png;base64,AAAA', mediaType: 'image/png' }],
    });
    expect(modelContent![0].type).toBe('image');
  });
});

describe('buildMcpToolContent', () => {
  it('emits a single text block for a plain (no-media) result', () => {
    const blocks = buildMcpToolContent({ ok: true, note: 'done' });
    expect(blocks).toEqual([{ type: 'text', text: JSON.stringify({ ok: true, note: 'done' }) }]);
  });

  it('emits an image block + JSON text block, in order', () => {
    const blocks = buildMcpToolContent({
      caption: 'a chart',
      _modelContent: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }],
    });
    expect(blocks).toEqual([
      { type: 'text', text: JSON.stringify({ caption: 'a chart' }) },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]);
  });

  it('omits the JSON block when _modelContent is the only field', () => {
    const blocks = buildMcpToolContent({
      _modelContent: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }],
    });
    expect(blocks).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
  });

  it('gives every file resource a UNIQUE uri (no attachment:///file collision)', () => {
    const blocks = buildMcpToolContent({
      _modelContent: [
        { type: 'file', data: 'AAAA', mediaType: 'application/pdf' }, // unnamed
        { type: 'file', data: 'BBBB', mediaType: 'application/pdf' }, // unnamed → would collide
        { type: 'file', data: 'CCCC', mediaType: 'text/plain', filename: 'a report.txt' }, // spaces → must encode
      ],
    });
    const uris = blocks
      .filter(
        (b): b is { type: 'resource'; resource: { blob: string; mimeType: string; uri: string } } =>
          b.type === 'resource',
      )
      .map((b) => b.resource.uri);
    expect(new Set(uris).size).toBe(3); // all distinct
    expect(uris[0]).toBe('attachment:///0-file');
    expect(uris[1]).toBe('attachment:///1-file');
    expect(uris[2]).toBe('attachment:///2-a%20report.txt'); // URI-encoded
  });

  it('never throws or emits undefined text for a cyclic (unserializable) result', () => {
    const cyclic: Record<string, unknown> = { note: 'hi' };
    cyclic.self = cyclic;
    const blocks = buildMcpToolContent(cyclic);
    const textBlock = blocks.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined;
    expect(textBlock).toBeDefined();
    expect(typeof textBlock!.text).toBe('string'); // never undefined / no throw
  });
});

describe('extractModelContent hardening', () => {
  it('strips a malformed (non-array) _modelContent from the visible result', () => {
    const { modelContent, cleaned } = extractModelContent({ ok: true, _modelContent: 'oops-not-an-array' });
    expect(modelContent).toBeNull();
    expect(cleaned).toEqual({ ok: true }); // reserved field removed even though malformed
  });

  it('rejects a file part with a non-string filename (would crash encodeURIComponent)', () => {
    const { modelContent } = extractModelContent({
      _modelContent: [{ type: 'file', data: 'AAAA', mediaType: 'application/pdf', filename: { evil: 1 } }],
    });
    expect(modelContent).toBeNull(); // dropped by validation
  });

  it('rejects image/file parts with empty data', () => {
    const { modelContent } = extractModelContent({
      _modelContent: [{ type: 'image', data: '', mediaType: 'image/png' }],
    });
    expect(modelContent).toBeNull();
  });

  it('caps the number of model-content parts kept', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ type: 'text', text: `t${i}` }));
    const { modelContent } = extractModelContent({ _modelContent: many });
    expect(modelContent!.length).toBeLessThanOrEqual(64);
  });
});

describe('applyMediaLimits (configurable byte caps)', () => {
  // These mutate module-level state; restore defaults after each test so the
  // rest of the suite sees the canonical 5/12 MiB caps.
  afterEach(() => {
    applyMediaLimits({ compaction: { media: { maxImageBytes: 5 * 1024 * 1024, maxTotalBytes: 12 * 1024 * 1024 } } });
  });

  it('defaults to 5 MiB per-part / 12 MiB per-result', () => {
    expect(getMaxPartBytes()).toBe(5 * 1024 * 1024);
    expect(getMaxTotalBytes()).toBe(12 * 1024 * 1024);
  });

  it('raises the per-image cap so a formerly-oversized image is kept', () => {
    const bigBase64 = 'A'.repeat(8 * 1024 * 1024); // ~6 MB decoded, over the 5 MB default
    // Default: dropped to a text note.
    expect(
      extractModelContent({ _modelContent: [{ type: 'image', data: bigBase64, mediaType: 'image/png' }] })
        .modelContent![0].type,
    ).toBe('text');
    // Raise the cap → same image is now retained as an image part.
    applyMediaLimits({ compaction: { media: { maxImageBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 } } });
    const kept = extractModelContent({
      _modelContent: [{ type: 'image', data: bigBase64, mediaType: 'image/png' }],
    }).modelContent!;
    expect(kept[0].type).toBe('image');
  });

  it('lowers the per-image cap so a formerly-kept image is dropped', () => {
    const midBase64 = 'A'.repeat(Math.ceil((3 * 1024 * 1024 * 4) / 3)); // ~3 MB decoded
    // Default: kept.
    expect(
      extractModelContent({ _modelContent: [{ type: 'image', data: midBase64, mediaType: 'image/png' }] })
        .modelContent![0].type,
    ).toBe('image');
    // Lower the cap below the image size → dropped to a note.
    applyMediaLimits({ compaction: { media: { maxImageBytes: 1 * 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 } } });
    expect(
      extractModelContent({ _modelContent: [{ type: 'image', data: midBase64, mediaType: 'image/png' }] })
        .modelContent![0].type,
    ).toBe('text');
  });

  it('clamps a per-part cap larger than the total down to the total', () => {
    applyMediaLimits({ compaction: { media: { maxImageBytes: 50 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 } } });
    expect(getMaxPartBytes()).toBe(10 * 1024 * 1024);
    expect(getMaxTotalBytes()).toBe(10 * 1024 * 1024);
  });

  it('falls back to defaults for missing/invalid config values', () => {
    applyMediaLimits({});
    expect(getMaxPartBytes()).toBe(5 * 1024 * 1024);
    expect(getMaxTotalBytes()).toBe(12 * 1024 * 1024);
    applyMediaLimits({ compaction: { media: { maxImageBytes: -1, maxTotalBytes: 0 } } });
    expect(getMaxPartBytes()).toBe(5 * 1024 * 1024);
    expect(getMaxTotalBytes()).toBe(12 * 1024 * 1024);
  });
});
