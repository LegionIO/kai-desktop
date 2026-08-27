import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { offloadTreeDisplayMedia } from '../offload-display-media';

// A tiny 1x1 PNG, base64.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function imageMsg(id: string, dataUrl: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    parentId: null,
    createdAt: '2026-08-26T00:00:00.000Z',
    content: [
      { type: 'text', text: 'look at this' },
      { type: 'image', image: dataUrl, mimeType: 'image/png' },
    ],
    tokenCount: 9999,
    tokenCountSig: 12345,
  };
}

describe('offloadTreeDisplayMedia', () => {
  let appHome: string;

  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'kai-offload-'));
  });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('writes a base64 image display part to disk and replaces it with a media URL', () => {
    const { tree, rewritten } = offloadTreeDisplayMedia([imageMsg('a', PNG_DATA_URL)], appHome);
    expect(rewritten).toBe(1);
    const node = (tree as Array<Record<string, unknown>>)[0];
    const parts = node.content as Array<Record<string, unknown>>;
    // Text part untouched.
    expect(parts[0]).toEqual({ type: 'text', text: 'look at this' });
    // Image swapped to a protocol URL under images/.
    expect(typeof parts[1].image).toBe('string');
    expect(parts[1].image as string).toMatch(/:\/\/images\/[0-9a-f]{16}\.png$/);
    expect((parts[1].image as string).startsWith('data:')).toBe(false);
    // File actually written under media/images and holds the decoded bytes.
    const imagesDir = join(appHome, 'media', 'images');
    const files = readdirSync(imagesDir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(imagesDir, files[0])).length).toBe(Buffer.from(PNG_B64, 'base64').length);
  });

  it('clears stale token caches on a rewritten node (content shrank)', () => {
    const { tree } = offloadTreeDisplayMedia([imageMsg('a', PNG_DATA_URL)], appHome);
    const node = (tree as Array<Record<string, unknown>>)[0];
    expect(node.tokenCount).toBeUndefined();
    expect(node.tokenCountSig).toBeUndefined();
    // Non-content fields survive.
    expect(node.id).toBe('a');
    expect(node.role).toBe('user');
  });

  it('is idempotent — re-offloading an already-URL tree is a no-op', () => {
    const first = offloadTreeDisplayMedia([imageMsg('a', PNG_DATA_URL)], appHome);
    expect(first.rewritten).toBe(1);
    const second = offloadTreeDisplayMedia(first.tree, appHome);
    expect(second.rewritten).toBe(0);
    expect(second.tree).toBe(first.tree); // unchanged reference when nothing rewritten
  });

  it('content-addresses: identical bytes across two messages reuse one file', () => {
    const { tree, rewritten } = offloadTreeDisplayMedia(
      [imageMsg('a', PNG_DATA_URL), imageMsg('b', PNG_DATA_URL)],
      appHome,
    );
    expect(rewritten).toBe(2);
    const nodes = tree as Array<Record<string, unknown>>;
    const urlA = (nodes[0].content as Array<Record<string, unknown>>)[1].image;
    const urlB = (nodes[1].content as Array<Record<string, unknown>>)[1].image;
    expect(urlA).toBe(urlB); // same content-addressed URL
    expect(readdirSync(join(appHome, 'media', 'images'))).toHaveLength(1); // one file on disk
  });

  it('offloads a file display part (data field)', () => {
    const node = {
      id: 'f',
      role: 'user',
      parentId: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      content: [{ type: 'file', data: PNG_DATA_URL, mimeType: 'image/png', filename: 'x.png' }],
    };
    const { tree, rewritten } = offloadTreeDisplayMedia([node], appHome);
    expect(rewritten).toBe(1);
    const part = ((tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[0];
    expect(part.data as string).toMatch(/:\/\/images\//);
    expect(part.filename).toBe('x.png'); // sibling fields preserved
  });

  it('leaves an already-http(s)/protocol URL untouched', () => {
    const httpNode = imageMsg('h', 'https://example.com/pic.png');
    const { tree, rewritten } = offloadTreeDisplayMedia([httpNode], appHome);
    expect(rewritten).toBe(0);
    const part = ((tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1];
    expect(part.image).toBe('https://example.com/pic.png');
  });

  it('NEVER descends into a tool result _modelContent (model view untouched)', () => {
    const toolNode = {
      id: 't',
      role: 'assistant',
      parentId: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      content: [
        {
          type: 'tool-call',
          toolName: 'plugin__x',
          result: {
            note: 'ok',
            // model-visible media — MUST be left byte-exact
            _modelContent: [{ type: 'image', data: PNG_B64, mediaType: 'image/png' }],
          },
        },
      ],
    };
    const { tree, rewritten } = offloadTreeDisplayMedia([toolNode], appHome);
    expect(rewritten).toBe(0);
    const result = ((tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[0]
      .result as Record<string, unknown>;
    const modelContent = result._modelContent as Array<Record<string, unknown>>;
    expect(modelContent[0].data).toBe(PNG_B64); // untouched
    expect(existsSync(join(appHome, 'media', 'images'))).toBe(false); // nothing written
  });

  it('leaves a malformed data URL inline rather than throwing', () => {
    const bad = imageMsg('m', 'data:image/png;base64,'); // empty payload
    const { tree, rewritten } = offloadTreeDisplayMedia([bad], appHome);
    expect(rewritten).toBe(0);
    const part = ((tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1];
    expect(part.image).toBe('data:image/png;base64,');
  });

  it('passes non-array / non-tree input through unchanged', () => {
    expect(offloadTreeDisplayMedia(null, appHome)).toEqual({ tree: null, rewritten: 0 });
    expect(offloadTreeDisplayMedia(undefined, appHome)).toEqual({ tree: undefined, rewritten: 0 });
    expect(offloadTreeDisplayMedia('nope', appHome)).toEqual({ tree: 'nope', rewritten: 0 });
  });
});
