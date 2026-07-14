import { describe, it, expect } from 'vitest';
import { extractModelContent } from '../tool-model-content.js';

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
