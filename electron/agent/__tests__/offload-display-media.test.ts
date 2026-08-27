import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  offloadTreeDisplayMedia,
  rehydrateModelMedia,
  rehydrateMediaUrl,
  collectReferencedMediaPaths,
  gcOrphanedMedia,
  stripUnresolvedOffloadedMedia,
} from '../offload-display-media';

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

describe('rehydrateModelMedia / rehydrateMediaUrl', () => {
  let appHome: string;
  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'kai-rehydrate-'));
  });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('round-trips: offload → rehydrate reproduces the original bytes', () => {
    const { tree } = offloadTreeDisplayMedia([imageMsg('a', PNG_DATA_URL)], appHome);
    const url = (tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    const mediaUrl = url[1].image as string;
    expect(mediaUrl.startsWith('data:')).toBe(false);

    const rehydrated = rehydrateModelMedia(tree as unknown[], appHome);
    const part = (rehydrated[0] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    const back = part[1].image as string;
    expect(back.startsWith('data:image/png;base64,')).toBe(true);
    // Bytes match the original payload.
    expect(back.split(',')[1]).toBe(PNG_B64);
  });

  it('rehydrateMediaUrl returns null for a non-media / traversal / missing value', () => {
    expect(rehydrateMediaUrl('data:image/png;base64,AAAA', appHome)).toBeNull(); // not a kai-media URL
    expect(rehydrateMediaUrl('https://x/y.png', appHome)).toBeNull();
    // Path traversal attempt must be rejected by containment.
    expect(rehydrateMediaUrl(`${__BRAND_MEDIA_PROTOCOL}://../../etc/passwd`, appHome)).toBeNull();
    // Missing file → null (leave the value as-is).
    expect(rehydrateMediaUrl(`${__BRAND_MEDIA_PROTOCOL}://images/deadbeef.png`, appHome)).toBeNull();
  });

  it('does not mutate the input array/objects (fresh copy on change)', () => {
    const { tree } = offloadTreeDisplayMedia([imageMsg('a', PNG_DATA_URL)], appHome);
    const input = tree as unknown[];
    const before = JSON.stringify(input);
    const out = rehydrateModelMedia(input, appHome);
    expect(JSON.stringify(input)).toBe(before); // input untouched
    expect(out).not.toBe(input); // new array when something changed
  });

  it('returns the SAME array reference when nothing needs rehydration', () => {
    const plain = [imageMsg('a', 'https://example.com/x.png')];
    expect(rehydrateModelMedia(plain, appHome)).toBe(plain);
  });

  it('rehydrates a file part and prefers the part mimeType', () => {
    const node = {
      id: 'f',
      role: 'user',
      parentId: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      content: [{ type: 'file', data: PNG_DATA_URL, mimeType: 'image/png', filename: 'x.png' }],
    };
    const { tree } = offloadTreeDisplayMedia([node], appHome);
    const rehydrated = rehydrateModelMedia(tree as unknown[], appHome);
    const part = (rehydrated[0] as Record<string, unknown>).content as Array<Record<string, unknown>>;
    expect((part[0].data as string).startsWith('data:image/png;base64,')).toBe(true);
  });

  it('NEVER rehydrates inside a tool-result _modelContent', () => {
    const toolNode = {
      id: 't',
      role: 'assistant',
      parentId: null,
      createdAt: '2026-08-26T00:00:00.000Z',
      content: [
        {
          type: 'tool-call',
          result: { _modelContent: [{ type: 'image', image: `${__BRAND_MEDIA_PROTOCOL}://images/abc.png` }] },
        },
      ],
    };
    const out = rehydrateModelMedia([toolNode], appHome);
    const result = ((out[0] as Record<string, unknown>).content as Array<Record<string, unknown>>)[0].result as Record<
      string,
      unknown
    >;
    // Untouched — still the kai-media URL, not a data URL.
    expect((result._modelContent as Array<Record<string, unknown>>)[0].image).toBe(
      `${__BRAND_MEDIA_PROTOCOL}://images/abc.png`,
    );
  });
});

describe('media GC (collectReferencedMediaPaths / gcOrphanedMedia)', () => {
  let appHome: string;
  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'kai-mediagc-'));
  });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('collects kai-media paths from anywhere in a tree (display parts AND tool results)', () => {
    const tree = [
      { id: 'u', role: 'user', content: [{ type: 'image', image: `${__BRAND_MEDIA_PROTOCOL}://images/aaaa.png` }] },
      {
        id: 'a',
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            result: { url: `${__BRAND_MEDIA_PROTOCOL}://videos/bbbb.mp4?x=1`, note: 'ok' },
          },
        ],
      },
      { id: 't', role: 'user', content: [{ type: 'text', text: 'no media here' }] },
    ];
    const refs = collectReferencedMediaPaths(tree);
    expect(refs.has('images/aaaa.png')).toBe(true);
    expect(refs.has('videos/bbbb.mp4')).toBe(true); // query stripped
    expect(refs.size).toBe(2);
  });

  it('removes orphaned files but KEEPS files still referenced by a survivor', () => {
    // Offload two distinct images.
    const A = 'data:image/png;base64,' + Buffer.from('AAAAAAAA').toString('base64');
    const B = 'data:image/png;base64,' + Buffer.from('BBBBBBBB').toString('base64');
    const aOut = offloadTreeDisplayMedia([imageMsg('a', A)], appHome);
    const bOut = offloadTreeDisplayMedia([imageMsg('b', B)], appHome);
    const aUrl = ((aOut.tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1]
      .image as string;
    const bUrl = ((bOut.tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1]
      .image as string;
    expect(readdirSync(join(appHome, 'media', 'images'))).toHaveLength(2);

    // Delete a conversation that referenced BOTH; a survivor still references B.
    const removedRefs = collectReferencedMediaPaths([{ content: [{ image: aUrl }, { image: bUrl }] }]);
    const survivingRefs = collectReferencedMediaPaths([{ content: [{ image: bUrl }] }]);
    const removed = gcOrphanedMedia(appHome, removedRefs, survivingRefs);

    expect(removed).toBe(1); // only A's file
    const remaining = readdirSync(join(appHome, 'media', 'images'));
    expect(remaining).toHaveLength(1);
    // The surviving file is B's.
    const bName = bUrl.split('/').pop();
    expect(remaining[0]).toBe(bName);
  });

  it('never unlinks outside mediaDir (path traversal in a ref is ignored)', () => {
    const removed = gcOrphanedMedia(appHome, new Set(['../../etc/passwd']), new Set());
    expect(removed).toBe(0);
  });
});

describe('rehydrateModelMedia byte cap (R2-4)', () => {
  let appHome: string;
  beforeEach(() => { appHome = mkdtempSync(join(tmpdir(), 'kai-rehy-cap-')); });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('stops rehydrating once the total-bytes cap is exceeded (leaves later URLs as URLs)', () => {
    // Offload two ~4KB images, then rehydrate with a tiny cap that fits only the first.
    const big = (seed: string) => 'data:image/png;base64,' + Buffer.alloc(4096, seed.charCodeAt(0)).toString('base64');
    const a = offloadTreeDisplayMedia([imageMsg('a', big('A'))], appHome);
    const b = offloadTreeDisplayMedia([imageMsg('b', big('B'))], appHome);
    const aUrl = ((a.tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1].image;
    const bUrl = ((b.tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1].image;
    const branch = [
      { id: 'a', role: 'user', parentId: null, content: [{ type: 'image', image: aUrl }] },
      { id: 'b', role: 'user', parentId: null, content: [{ type: 'image', image: bUrl }] },
    ];
    const out = rehydrateModelMedia(branch, appHome, 5000); // room for one 4KB image only
    const first = (out[0] as { content: Array<Record<string, unknown>> }).content[0].image as string;
    const second = (out[1] as { content: Array<Record<string, unknown>> }).content[0].image as string;
    // Budgeting is NEWEST-FIRST: the most-recent (end-of-branch) attachment is kept,
    // the older one is shed when the cap is hit (the current turn is about the newest).
    expect(second.startsWith('data:')).toBe(true); // newest rehydrated (within cap)
    expect(first.startsWith('data:')).toBe(false); // oldest left as a URL (cap exhausted)
    expect(first).toBe(aUrl);
  });
});

describe('collectReferencedMediaPaths — embedded URLs (R3-F2)', () => {
  it('finds kai-media URLs embedded in markdown / prose / html, not just bare values', () => {
    const proto = __BRAND_MEDIA_PROTOCOL;
    const tree = [
      { role: 'assistant', content: [{ type: 'text', text: `see ![x](${proto}://images/aaaa.png) and more` }] },
      { role: 'assistant', content: [{ type: 'text', text: `<img src="${proto}://videos/bbbb.mp4?t=1">` }] },
      { role: 'user', content: [{ type: 'image', image: `${proto}://images/cccc.png` }] },
    ];
    const refs = collectReferencedMediaPaths(tree);
    expect(refs.has('images/aaaa.png')).toBe(true); // markdown link
    expect(refs.has('videos/bbbb.mp4')).toBe(true); // html src, query stripped
    expect(refs.has('images/cccc.png')).toBe(true); // bare value
    expect(refs.size).toBe(3);
  });

  it('does not let a markdown-embedded surviving ref be GC-deleted', () => {
    const proto = __BRAND_MEDIA_PROTOCOL;
    const removed = collectReferencedMediaPaths([{ content: [{ image: `${proto}://images/shared0000000.png` }] }]);
    // A survivor references the same file ONLY via markdown text.
    const surviving = collectReferencedMediaPaths([
      { content: [{ type: 'text', text: `![keep](${proto}://images/shared0000000.png)` }] },
    ]);
    expect(surviving.has('images/shared0000000.png')).toBe(true);
    // gcOrphanedMedia would skip it because it's in survivingRefs (no unlink attempted).
    expect(removed.size).toBe(1);
    expect(surviving.has([...removed][0])).toBe(true);
  });
});

describe('active-format handling (R4-T1: no XSS-capable offload)', () => {
  let appHome: string;
  beforeEach(() => { appHome = mkdtempSync(join(tmpdir(), 'kai-active-')); });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('does NOT offload an SVG image (keeps it inline — no servable URL)', () => {
    const svg = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const { tree, rewritten } = offloadTreeDisplayMedia([imageMsg('s', svg)], appHome);
    expect(rewritten).toBe(0); // left inline
    const part = ((tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1];
    expect(part.image).toBe(svg);
    // No file written under media/.
    expect(existsSync(join(appHome, 'media', 'images'))).toBe(false);
    expect(existsSync(join(appHome, 'media', 'files'))).toBe(false);
  });

  it('does NOT offload an HTML file (keeps it inline)', () => {
    const html = 'data:text/html;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
    const node = {
      id: 'h', role: 'user', parentId: null, createdAt: '2026-08-26T00:00:00.000Z',
      content: [{ type: 'file', data: html, mimeType: 'text/html', filename: 'x.html' }],
    };
    const { rewritten } = offloadTreeDisplayMedia([node], appHome);
    expect(rewritten).toBe(0);
    expect(existsSync(join(appHome, 'media', 'files'))).toBe(false);
  });

  it('still offloads a normal PNG (regression guard)', () => {
    const { rewritten } = offloadTreeDisplayMedia([imageMsg('p', PNG_DATA_URL)], appHome);
    expect(rewritten).toBe(1);
  });
});

describe('stripUnresolvedOffloadedMedia (R4-T2)', () => {
  it('replaces a leftover kai-media:// part with an omission note; leaves data:/http', () => {
    const proto = __BRAND_MEDIA_PROTOCOL;
    const msgs = [
      { role: 'user', content: [
        { type: 'text', text: 'hi' },
        { type: 'image', image: `${proto}://images/unresolved0000.png` },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ] },
    ];
    const out = stripUnresolvedOffloadedMedia(msgs) as Array<{ content: Array<Record<string, unknown>> }>;
    expect(out[0].content[0]).toEqual({ type: 'text', text: 'hi' });
    expect(out[0].content[1].type).toBe('text'); // unresolved URL → omission note
    expect(String(out[0].content[1].text)).toMatch(/omitted/i);
    expect(out[0].content[2].image).toBe('data:image/png;base64,AAAA'); // data URL untouched
  });
});

describe('rehydration per-occurrence cap (R5-F2)', () => {
  let appHome: string;
  beforeEach(() => { appHome = mkdtempSync(join(tmpdir(), 'kai-dup-')); });
  afterEach(() => rmSync(appHome, { recursive: true, force: true }));

  it('charges the cap per OCCURRENCE of a repeated URL (no dedup bypass)', () => {
    // One ~4KB image offloaded, then referenced TWICE. With a cap that fits only ONE
    // copy, exactly one occurrence must rehydrate; the other stays a URL.
    const img = 'data:image/png;base64,' + Buffer.alloc(4096, 65).toString('base64');
    const off = offloadTreeDisplayMedia([imageMsg('a', img)], appHome);
    const url = ((off.tree as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)[1].image as string;
    const branch = [
      { id: 'x', role: 'user', parentId: null, content: [{ type: 'image', image: url }] },
      { id: 'y', role: 'user', parentId: null, content: [{ type: 'image', image: url }] },
    ];
    const out = rehydrateModelMedia(branch, appHome, 5000); // room for one 4KB copy only
    const a = (out[0] as { content: Array<Record<string, unknown>> }).content[0].image as string;
    const b = (out[1] as { content: Array<Record<string, unknown>> }).content[0].image as string;
    const rehydratedCount = [a, b].filter((v) => v.startsWith('data:')).length;
    expect(rehydratedCount).toBe(1); // NOT 2 — the second copy is charged and left a URL
  });
});
