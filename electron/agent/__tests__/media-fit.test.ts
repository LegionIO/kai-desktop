import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  estimateImageTokensFromDimensions,
  estimateImageTokensFromBytes,
  estimateFileTokensFromBytes,
  estimateNativeMediaTokens,
  fitImagePart,
  fitModelContentToBudget,
  stripBranchMediaForCount,
  type MediaFitConfig,
} from '../media-fit';

const CONFIG: MediaFitConfig = {
  enabled: true,
  strategy: 'downscale',
  minDimension: 256,
  minQuality: 40,
  reserveTokens: 4000,
};

/** Bare base64 for N raw bytes (payload content is irrelevant to the byte-based path). */
function base64OfBytes(n: number): string {
  return Buffer.alloc(n, 0x41).toString('base64');
}

describe('estimateImageTokensFromDimensions', () => {
  it('scales with pixel area and never under-counts the two provider families', () => {
    const small = estimateImageTokensFromDimensions(256, 256);
    const large = estimateImageTokensFromDimensions(2048, 2048);
    expect(large).toBeGreaterThan(small);
    // 2048² area/750 ≈ 5592; tile cost = 85 + 170*16 = 2805 → area wins here.
    expect(large).toBeGreaterThanOrEqual(Math.ceil((2048 * 2048) / 750));
  });

  it('returns 0 for degenerate dimensions', () => {
    expect(estimateImageTokensFromDimensions(0, 100)).toBe(0);
    expect(estimateImageTokensFromDimensions(-1, 10)).toBe(0);
    expect(estimateImageTokensFromDimensions(NaN, 10)).toBe(0);
  });

  it('covers the patch-based (GPT-4.1 mini/nano) vision cost, not just tiles/area', () => {
    // A 1024×1024 image on GPT-4.1-nano ≈ 1024 patches × ~2.46 ≈ 2519 tokens; the
    // legacy tile/area formulas undercount (~1399). The estimate must not fall below
    // the patch-based cost or the fitter could retain an overflowing image.
    const est = estimateImageTokensFromDimensions(1024, 1024);
    expect(est).toBeGreaterThanOrEqual(2500);
  });
});

describe('estimateImageTokensFromBytes', () => {
  it('over-estimates (~2 bytes/token) so the fail-safe stays conservative', () => {
    // 1 MiB raw → ~512k tokens (deliberately huge so a big image reads as costly).
    const est = estimateImageTokensFromBytes(base64OfBytes(1024 * 1024));
    expect(est).toBeGreaterThan(400_000);
  });
});

describe('estimateFileTokensFromBytes', () => {
  it('charges the FULL decoded-byte ceiling (files can be ~1 token/byte)', () => {
    const data = base64OfBytes(4000);
    const est = estimateFileTokensFromBytes(data);
    expect(est).toBe(Math.floor((data.length * 3) / 4));
    // Twice the image bytes/2 estimate — files are not halved.
    expect(est).toBeGreaterThan(estimateImageTokensFromBytes(data));
  });

  it('strips a data-URL prefix before counting (and honors its MIME for the document multiplier)', () => {
    const bare = base64OfBytes(4000);
    // A non-document data-URL: same byte ceiling as the bare payload (prefix stripped).
    const plainUrl = `data:application/octet-stream;base64,${bare}`;
    expect(estimateFileTokensFromBytes(plainUrl)).toBe(estimateFileTokensFromBytes(bare));
    // A PDF data-URL declared with NO outer mediaType still gets the document
    // expansion multiplier (the downstream sanitizer adopts the data-URL MIME).
    const pdfUrl = `data:application/pdf;base64,${bare}`;
    expect(estimateFileTokensFromBytes(pdfUrl)).toBe(estimateFileTokensFromBytes(bare) * 5);
  });

  it('applies a document expansion multiplier for PDF/Office mime types', () => {
    const data = base64OfBytes(4000);
    const plain = estimateFileTokensFromBytes(data, 'application/octet-stream');
    const pdf = estimateFileTokensFromBytes(data, 'application/pdf');
    const docx = estimateFileTokensFromBytes(
      data,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    // Documents can rasterize/expand beyond their bytes → charged more so they
    // shrink/drop rather than silently overflow the next step.
    expect(pdf).toBeGreaterThan(plain);
    expect(docx).toBeGreaterThan(plain);
    // No mediaType → base byte count (no multiplier).
    expect(estimateFileTokensFromBytes(data)).toBe(plain);
  });
});

describe('estimateNativeMediaTokens', () => {
  it('files use the full byte ceiling (a true upper bound, not bytes/2)', async () => {
    const data = base64OfBytes(4000);
    const est = await estimateNativeMediaTokens(data, false);
    // The full decoded byte count (≤ 1 token/byte ceiling) — roughly 2× the image
    // byte estimate (which divides by 2).
    expect(est).toBe(Math.floor((data.length * 3) / 4));
    expect(est).toBeGreaterThan(estimateImageTokensFromBytes(data));
  });

  it('strips a data-URL prefix before estimating a file, honoring its MIME', async () => {
    const bare = base64OfBytes(4000);
    // A NON-document data-URL → byte ceiling of the bare payload (prefix stripped).
    const plainUrl = `data:application/octet-stream;base64,${bare}`;
    expect(await estimateNativeMediaTokens(plainUrl, false)).toBe(Math.floor((bare.length * 3) / 4));
    // A PDF data-URL → document expansion multiplier even with no outer mediaType.
    const pdfUrl = `data:application/pdf;base64,${bare}`;
    expect(await estimateNativeMediaTokens(pdfUrl, false)).toBe(Math.floor((bare.length * 3) / 4) * 5);
  });
});

describe('fitImagePart with UNMEASURABLE payload (no sharp / corrupt image) — fails closed', () => {
  // sharp IS installed in this env, so a fake/corrupt payload reaches sharp's
  // metadata() which throws → the catch (mirrors the no-sharp path) now DROPS the
  // unverifiable image rather than trusting a byte estimate that can't bound a
  // compressed large-dimension pixel bomb.
  it('drops an unverifiable image with a resize/re-encode note even when it "fits" by bytes', async () => {
    const data = base64OfBytes(1000); // small by bytes, but dimensions unknowable
    const res = await fitImagePart(data, 'image/png', 100_000, { ...CONFIG, strategy: 'drop' });
    expect(res.kind).toBe('dropped');
    if (res.kind === 'dropped') expect(res.note).toMatch(/resize or re-encode/i);
  });

  it('drops an unverifiable image regardless of budget size', async () => {
    const data = base64OfBytes(2 * 1024 * 1024);
    const res = await fitImagePart(data, 'image/png', 1000, { ...CONFIG, strategy: 'drop' });
    expect(res.kind).toBe('dropped');
    if (res.kind === 'dropped') expect(res.note).toMatch(/resize or re-encode/i);
  });

  it('strips a data-URL prefix before attempting to measure (drop mode)', async () => {
    const bare = base64OfBytes(1000);
    const withPrefix = `data:image/png;base64,${bare}`;
    // Unverifiable → dropped; originalTokens reflect the BARE payload (prefix stripped).
    const res = await fitImagePart(withPrefix, 'image/png', 100_000, { ...CONFIG, strategy: 'drop' });
    expect(res.kind).toBe('dropped');
    if (res.kind === 'dropped') expect(res.originalTokens).toBe(estimateImageTokensFromBytes(bare));
  });
});

describe('fitModelContentToBudget', () => {
  it('is a no-op when disabled', async () => {
    const parts = [{ type: 'image' as const, data: base64OfBytes(5_000_000), mediaType: 'image/png' }];
    const res = await fitModelContentToBudget(parts, 10, { ...CONFIG, enabled: false });
    expect(res.changed).toBe(false);
    expect(res.parts).toEqual(parts);
  });

  it('passes parts through untouched when the abort signal is already set (no sharp work)', async () => {
    const parts = [
      { type: 'text' as const, text: 'y'.repeat(500_000) },
      { type: 'image' as const, data: base64OfBytes(5_000_000), mediaType: 'image/png' },
    ];
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await fitModelContentToBudget(parts, 1, CONFIG, ctrl.signal);
    // Cancelled → everything passes through unchanged (nothing is sent anyway).
    expect(res.changed).toBe(false);
    expect(res.parts).toEqual(parts);
  });

  it('passes text and file parts through unchanged', async () => {
    const parts = [
      { type: 'text' as const, text: 'hello' },
      { type: 'file' as const, data: base64OfBytes(1000), mediaType: 'application/pdf', filename: 'a.pdf' },
    ];
    const res = await fitModelContentToBudget(parts, 100_000, CONFIG);
    expect(res.changed).toBe(false);
    expect(res.parts).toEqual(parts);
  });

  it('drops an over-budget image (strategy drop) and flags dropped + note', async () => {
    const parts = [{ type: 'image' as const, data: base64OfBytes(3 * 1024 * 1024), mediaType: 'image/png' }];
    const res = await fitModelContentToBudget(parts, 1000, { ...CONFIG, strategy: 'drop' });
    expect(res.changed).toBe(true);
    expect(res.dropped).toBe(true);
    // The image part is replaced by a single text note.
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0].type).toBe('text');
    expect(res.note).toMatch(/omitted/i);
  });

  it('emits omission notes only within budget; drops silently once exhausted', async () => {
    // With a budget large enough for ONE note but not the media, the first drop
    // emits a note (counted) and the second, now over budget, drops SILENTLY so
    // the notes can't collectively overflow. Both are still recorded as dropped.
    const parts = [
      { type: 'image' as const, data: base64OfBytes(3 * 1024 * 1024), mediaType: 'image/png' },
      { type: 'image' as const, data: base64OfBytes(3 * 1024 * 1024), mediaType: 'image/png' },
    ];
    const noteBudget = 200; // enough for one ~100-byte note, not for the media
    const res = await fitModelContentToBudget(parts, noteBudget, { ...CONFIG, strategy: 'drop' });
    expect(res.dropped).toBe(true);
    // Kept tokens (the emitted note bytes) never exceed the budget.
    expect(res.keptTokens).toBeLessThanOrEqual(noteBudget);
    // Fewer text notes than dropped images (the 2nd was dropped silently).
    const noteParts = res.parts.filter((p) => p.type === 'text').length;
    expect(noteParts).toBeLessThan(2);
  });

  it('drops omission notes entirely when budget is zero (no overflow from notes)', async () => {
    const parts = [{ type: 'image' as const, data: base64OfBytes(3 * 1024 * 1024), mediaType: 'image/png' }];
    const res = await fitModelContentToBudget(parts, 1, { ...CONFIG, strategy: 'drop' });
    expect(res.dropped).toBe(true);
    expect(res.keptTokens).toBe(0); // note didn't fit → dropped silently
  });

  it('drops each unverifiable image (fake payloads can not be measured)', async () => {
    // Fake payloads reach sharp.metadata() which throws → fail closed (drop). Two
    // such images both drop; the aggregate result records the change.
    const small = base64OfBytes(1000);
    const parts = [
      { type: 'image' as const, data: small, mediaType: 'image/png' },
      { type: 'image' as const, data: small, mediaType: 'image/png' },
    ];
    const res = await fitModelContentToBudget(parts, 100_000, { ...CONFIG, strategy: 'drop' });
    expect(res.changed).toBe(true);
    expect(res.dropped).toBe(true);
    expect(res.parts.every((p) => p.type !== 'image')).toBe(true);
  });

  it('passes a malformed image part (no data) through untouched — never throws', async () => {
    const parts = [
      { type: 'image' as const, data: undefined as unknown as string, mediaType: 'image/png' },
      { type: 'image' as const, data: '', mediaType: 'image/png' },
      { type: 'image' as const, data: base64OfBytes(500) } as unknown as {
        type: 'image';
        data: string;
        mediaType: string;
      }, // missing mediaType
    ];
    const res = await fitModelContentToBudget(parts, 100_000, { ...CONFIG, strategy: 'drop' });
    expect(res.changed).toBe(false);
    expect(res.parts).toEqual(parts);
    expect(res.keptTokens).toBe(0);
  });

  it('drops an oversized image WITHOUT decoding (base64 over the per-image ceiling)', async () => {
    // ~8 MiB raw → base64 over the 5 MiB decode ceiling; must drop pre-decode.
    const huge = base64OfBytes(8 * 1024 * 1024);
    const res = await fitModelContentToBudget([{ type: 'image' as const, data: huge, mediaType: 'image/png' }], 10_000_000, CONFIG);
    expect(res.dropped).toBe(true);
    expect(res.note).toMatch(/omitted/i);
  });

  it('budgets file parts and drops an over-budget file with a note', async () => {
    const bigPdf = base64OfBytes(2 * 1024 * 1024); // ~1M byte-estimate tokens
    const res = await fitModelContentToBudget(
      [{ type: 'file' as const, data: bigPdf, mediaType: 'application/pdf', filename: 'big.pdf' }],
      1000,
      CONFIG,
    );
    expect(res.dropped).toBe(true);
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0].type).toBe('text');
  });

  it('a file over the FIXED 5 MiB per-part limit is told to send a smaller file, NOT /compact', async () => {
    // ~7 MiB file: fails the fixed MAX_DECODE_BYTES cap, not the context budget. The
    // omission note must recommend a smaller file (compaction cannot change the cap).
    const big = base64OfBytes(7 * 1024 * 1024);
    const res = await fitModelContentToBudget(
      [{ type: 'file' as const, data: big, mediaType: 'application/pdf', filename: 'huge.pdf' }],
      100_000_000, // ample context budget → the ONLY reason to drop is the fixed limit
      CONFIG,
    );
    expect(res.dropped).toBe(true);
    const note = (res.parts[0] as { text?: string }).text ?? '';
    expect(note).toMatch(/smaller file/i);
    expect(note).not.toMatch(/\/compact/);
    // The AGGREGATE note (the only text the user actually sees — inline notes are
    // stripped by the UI) must carry the remedy, not "see notes above".
    expect(res.note).toMatch(/smaller file/i);
    expect(res.note).not.toMatch(/see notes above/i);
  });

  it('keeps a small file part and counts it toward keptTokens', async () => {
    const res = await fitModelContentToBudget(
      [{ type: 'file' as const, data: base64OfBytes(400), mediaType: 'application/pdf' }],
      100_000,
      CONFIG,
    );
    expect(res.changed).toBe(false);
    expect(res.keptTokens).toBeGreaterThan(0);
  });

  it('reports keptMediaBytes for a kept file (decoded bytes)', async () => {
    const res = await fitModelContentToBudget(
      [{ type: 'file' as const, data: base64OfBytes(4096), mediaType: 'application/pdf' }],
      100_000,
      CONFIG,
    );
    // The kept file's decoded bytes are surfaced so the turn can accumulate them.
    expect(res.keptMediaBytes).toBeGreaterThanOrEqual(4000);
    expect(res.keptMediaBytes).toBeLessThanOrEqual(4200);
  });

  it('seeds the WHOLE-REQUEST media ceiling so cumulative branch+turn media is bounded', async () => {
    // A ~4 MiB file fits the TOKEN budget and the per-result byte cap comfortably.
    const file = { type: 'file' as const, data: base64OfBytes(4 * 1024 * 1024), mediaType: 'application/pdf' };
    // Alone (no prior committed media): kept.
    const first = await fitModelContentToBudget([file], 100_000_000, CONFIG, undefined, 0);
    expect(first.dropped).toBe(false);
    expect(first.keptMediaBytes).toBeGreaterThan(3 * 1024 * 1024);

    // Seed BELOW the default 20 MiB whole-request ceiling (e.g. 14 MiB of prior
    // branch/turn media): a 4 MiB file (per-call aggregate only 4 MiB, well under the
    // 12 MiB per-message cap) still fits the whole request → KEPT.
    const underCeiling = await fitModelContentToBudget([file], 100_000_000, CONFIG, undefined, 14 * 1024 * 1024);
    expect(underCeiling.dropped).toBe(false);

    // Seed NEAR the ceiling (18 MiB): adding ~4 MiB would cross the 20 MiB whole-
    // request ceiling → dropped (loudly), NOT kept — even though the per-call 12 MiB
    // aggregate is not exceeded (this is the cross-turn accumulation the seed guards).
    const overCeiling = await fitModelContentToBudget([file], 100_000_000, CONFIG, undefined, 18 * 1024 * 1024);
    expect(overCeiling.dropped).toBe(true);
    expect(overCeiling.keptMediaBytes).toBe(0);
    expect(overCeiling.parts[0].type).toBe('text'); // omission note replaces the file
  });

  it('still enforces the 12 MiB PER-CALL aggregate cap within one result (unseeded)', async () => {
    // Three ~4.5 MiB files in ONE result (each under the 5 MiB per-part cap): the
    // first two fit (~9 MiB), the third crosses the 12 MiB per-call aggregate → the
    // third is dropped even with a zero seed.
    const f = () => ({ type: 'file' as const, data: base64OfBytes(Math.floor(4.5 * 1024 * 1024)), mediaType: 'application/pdf' });
    const res = await fitModelContentToBudget([f(), f(), f()], 100_000_000, CONFIG, undefined, 0);
    expect(res.dropped).toBe(true);
    // Two files kept (~9 MiB); the third replaced by an omission note.
    expect(res.keptMediaBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(res.keptMediaBytes).toBeLessThan(12 * 1024 * 1024);
    // The per-RESULT (fixed 12 MiB) cap fired with an EMPTY history — /compact can't
    // help, so the aggregate note must recommend smaller/fewer media, not /compact.
    expect(res.note).not.toMatch(/\/compact/);
    expect(res.note).toMatch(/smaller/i);
  });

  it('recommends /compact when the WHOLE-REQUEST cap fires (branch accumulation, not this result)', async () => {
    // One ~4 MiB file, but the whole-request ceiling is nearly full from prior turns
    // (18 MiB seed vs 20 MiB default). This result's own media is under the per-result
    // cap, so the drop is due to cross-turn accumulation → /compact CAN free space.
    const file = { type: 'file' as const, data: base64OfBytes(4 * 1024 * 1024), mediaType: 'application/pdf' };
    const res = await fitModelContentToBudget([file], 100_000_000, CONFIG, undefined, 18 * 1024 * 1024);
    expect(res.dropped).toBe(true);
    expect(res.note).toMatch(/\/compact/);
  });

  it('honors an explicit maxTotalMediaBytes override below the default', async () => {
    const file = { type: 'file' as const, data: base64OfBytes(4 * 1024 * 1024), mediaType: 'application/pdf' };
    // Tiny 1 MiB ceiling → even a fresh 4 MiB file (zero seed) is dropped.
    const res = await fitModelContentToBudget([file], 100_000_000, CONFIG, undefined, 0, 1 * 1024 * 1024);
    expect(res.dropped).toBe(true);
    expect(res.keptMediaBytes).toBe(0);
  });

  it('drops a file whose decoded size sits between budget and 2×budget (full-ceiling, not bytes/2)', async () => {
    // 4000 decoded bytes → full ceiling 4000 tokens; a budget of 3000 is under the
    // full ceiling but ABOVE bytes/2 (2000). The old image-estimate would have kept
    // it and risked overflow; the file ceiling must drop it.
    const data = base64OfBytes(4000);
    const budget = 3000;
    expect(estimateFileTokensFromBytes(data)).toBeGreaterThan(budget);
    expect(estimateImageTokensFromBytes(data)).toBeLessThan(budget);
    const res = await fitModelContentToBudget(
      [{ type: 'file' as const, data, mediaType: 'application/pdf', filename: 'mid.pdf' }],
      budget,
      CONFIG,
    );
    expect(res.dropped).toBe(true);
    expect(res.parts.every((p) => p.type !== 'file')).toBe(true);
  });

  it('never emits an empty text part when the budget is exhausted (provider-invalid)', async () => {
    // A big text part budgeted to 0 tokens: truncation yields '' — the result must
    // NOT contain an empty text block (providers like Anthropic reject them), but
    // the change must still be recorded in the note.
    const parts = [{ type: 'text' as const, text: 'z'.repeat(50_000) }];
    const res = await fitModelContentToBudget(parts, 0, CONFIG);
    expect(res.changed).toBe(true);
    const emptyText = res.parts.some((p) => p.type === 'text' && (p as { text: string }).text.length === 0);
    expect(emptyText).toBe(false);
    expect(res.note).toMatch(/truncat/i);
  });

  it('over-cap text truncated past the fit-part cap still yields a non-empty change note', async () => {
    // 65 valid text parts: the first 64 consume the fit cap; part #65 is over-cap
    // AND over the (exhausted) budget, so it's truncated. That truncation must be
    // COUNTED so the summary note isn't empty while changed=true (an empty note
    // makes the caller emit a malformed informational message).
    const parts = Array.from({ length: 65 }, (_v, i) => ({
      type: 'text' as const,
      text: i < 64 ? 'x'.repeat(40) : 'y'.repeat(200_000),
    }));
    // Budget large enough for the 64 small parts but not the huge #65.
    const res = await fitModelContentToBudget(parts, 2000, CONFIG);
    expect(res.changed).toBe(true);
    expect(res.note).not.toBe('');
    expect(res.note).toMatch(/truncat/i);
  });

  it('drops over-cap media rather than passing it through unfit', async () => {
    const small = base64OfBytes(200);
    const parts = Array.from({ length: 70 }, () => ({ type: 'image' as const, data: small, mediaType: 'image/png' }));
    // Tiny budget → all fit images drop; parts BEYOND the 64-part fit cap are also
    // dropped (NOT passed through unfit — that could send them at full size past
    // the downstream sanitizer). So no image survives.
    const res = await fitModelContentToBudget(parts, 1, { ...CONFIG, strategy: 'drop' });
    const survivingImages = res.parts.filter((p) => p.type === 'image').length;
    expect(survivingImages).toBe(0);
    expect(res.dropped).toBe(true);
  });

  it('passes a null/undefined array entry through without throwing', async () => {
    const parts = [
      null as unknown as { type: 'text'; text: string },
      undefined as unknown as { type: 'text'; text: string },
      { type: 'image' as const, data: base64OfBytes(300), mediaType: 'image/png' },
    ];
    const res = await fitModelContentToBudget(parts, 100_000, { ...CONFIG, strategy: 'drop' });
    // Null/undefined survive in place; the valid small image is kept.
    expect(res.parts[0]).toBeNull();
    expect(res.parts[1]).toBeUndefined();
  });

  it('keeps a small text part whole and truncates a large one to budget', async () => {
    const smallText = { type: 'text' as const, text: 'x'.repeat(100) };
    const bigText = { type: 'text' as const, text: 'y'.repeat(500_000) };
    const res = await fitModelContentToBudget([smallText, bigText], 1000, CONFIG);
    expect(res.changed).toBe(true);
    const outBig = res.parts.find((p) => p.type === 'text' && (p as { text: string }).text.includes('truncat'));
    expect(outBig).toBeDefined();
    // Truncated text is far shorter than the original.
    const truncatedLen = (outBig as { text: string }).text.length;
    expect(truncatedLen).toBeLessThan(500_000);
  });

  it('truncated text fits the byte budget even for token-dense Unicode', async () => {
    // Multi-byte chars: byte ceiling (not chars/4) must bound the result.
    const bigUnicode = { type: 'text' as const, text: '你'.repeat(200_000) };
    const budget = 500; // tokens
    const res = await fitModelContentToBudget([bigUnicode], budget, CONFIG);
    const out = res.parts.find((p) => p.type === 'text') as { text: string };
    // The kept text's UTF-8 byte length (token ceiling) must not exceed the budget.
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(budget);
  });

  it('bounds the truncation marker to the budget when smaller than the full marker', async () => {
    const res = await fitModelContentToBudget([{ type: 'text' as const, text: 'z'.repeat(10_000) }], 5, CONFIG);
    const out = res.parts.find((p) => p.type === 'text') as { text: string };
    // Budget 5 < marker length → marker is clamped to 5 bytes (not emitted at
    // full 17-byte length, which could itself overflow at reserveTokens:0).
    expect(Buffer.byteLength(out.text, 'utf8')).toBeLessThanOrEqual(5);
  });

  it('reports a non-empty note when only text is truncated (no malformed UI message)', async () => {
    const res = await fitModelContentToBudget([{ type: 'text' as const, text: 'y'.repeat(500_000) }], 1000, CONFIG);
    expect(res.changed).toBe(true);
    expect(res.note).toMatch(/text block\(s\) truncated/);
  });
});

// -----------------------------------------------------------------------------
// Downscale path with a mocked sharp — exercises resize/re-encode branch without
// the native addon (real .node behavior is covered by manual/integration runs).
// -----------------------------------------------------------------------------
describe('fitImagePart downscale (mocked sharp)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('downscales toward the floor until the estimate fits, else drops', async () => {
    // A fake sharp: metadata reports a huge image; resize returns an image at the
    // requested longest edge so the token estimate shrinks with each halving.
    let currentEdge = 8192;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = (opts: { width: number }) => {
        currentEdge = opts.width;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'png' });
      pipeline.toBuffer = async () => ({
        data: Buffer.alloc(64, 0x42),
        info: { width: currentEdge, height: currentEdge },
      });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    // Budget large enough that a downscaled (but not floor) image fits.
    const res = await fit(base64OfBytes(4 * 1024 * 1024), 'image/png', 60_000, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('downscaled');
    if (res.kind === 'downscaled') {
      expect(res.note).toMatch(/downscaled/i);
      expect(res.estimatedTokens).toBeLessThanOrEqual(60_000);
    }
  });

  it('fails safe (dropped) when even the floor size is over budget', async () => {
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      let edge = 256;
      pipeline.resize = (opts: { width: number }) => {
        edge = opts.width;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'png' });
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: edge, height: edge } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    // Budget below even the 256px floor estimate → drop.
    const res = await fit(base64OfBytes(4 * 1024 * 1024), 'image/png', 1, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('dropped');
    if (res.kind === 'dropped') expect(res.note).toMatch(/\/compact/);
  });

  it('returns unchanged without any sharp decode/resize when the signal is pre-aborted', async () => {
    let metadataCalled = false;
    let resizeCalled = false;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = () => {
        resizeCalled = true;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => {
        metadataCalled = true;
        return { width: 8192, height: 8192, format: 'png' };
      };
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: 256, height: 256 } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    const ctrl = new AbortController();
    ctrl.abort();
    // A tiny budget would normally force a downscale/drop; the pre-set abort must
    // short-circuit to `unchanged` before touching sharp (no CPU spent on the fit).
    const res = await fit(
      base64OfBytes(4 * 1024 * 1024),
      'image/png',
      1,
      { strategy: 'downscale', minDimension: 256, minQuality: 40 },
      ctrl.signal,
    );
    expect(res.kind).toBe('unchanged');
    expect(metadataCalled).toBe(false);
    expect(resizeCalled).toBe(false);
  });

  it('drops a pixel-bomb (huge declared dimensions) without resizing', async () => {
    let resizeCalled = false;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = () => {
        resizeCalled = true;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      // 30000×30000 = 900 MP, over the 100 MP MAX_DECODE_PIXELS cap.
      pipeline.metadata = async () => ({ width: 30000, height: 30000, format: 'png' });
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: 256, height: 256 } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    const res = await fit(base64OfBytes(1024), 'image/png', 100, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('dropped');
    if (res.kind === 'dropped') expect(res.note).toMatch(/maximum resizable dimensions/);
    expect(resizeCalled).toBe(false); // never decoded/resized the pixel bomb
  });

  it('keeps shrinking when a re-encode still exceeds the per-part byte cap', async () => {
    // First resize returns an over-5MiB buffer (must be rejected); the next
    // (smaller) resize returns a small buffer that is accepted.
    const sizes = [6 * 1024 * 1024, 1024];
    let call = 0;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      let edge = 4096;
      pipeline.resize = (opts: { width: number }) => {
        edge = opts.width;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'jpeg' });
      pipeline.toBuffer = async () => {
        const sz = sizes[Math.min(call, sizes.length - 1)];
        call += 1;
        return { data: Buffer.alloc(sz, 0x42), info: { width: edge, height: edge } };
      };
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    // Budget forces a downscale (original 8192² ≈ 89K tokens > budget), and the
    // first re-encode fits by TOKENS (4096² ≈ 22K < 30K) but exceeds the 5 MiB
    // byte cap — so it must keep shrinking to the second (small) buffer.
    const res = await fit(base64OfBytes(4 * 1024 * 1024), 'image/jpeg', 30_000, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('downscaled');
    if (res.kind === 'downscaled') {
      // Accepted output must be under the 5 MiB per-part cap.
      expect(Buffer.from(res.data, 'base64').byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
    }
    expect(call).toBeGreaterThanOrEqual(2); // proved it rejected the first oversized re-encode
  });

  it('lowers JPEG quality toward the floor to fit the byte cap without halving dimensions', async () => {
    // Token estimate fits at the first edge, but the byte cap is exceeded at high
    // quality; only when quality drops enough does the buffer fit — at the SAME
    // edge. A correct implementation keeps resolution via quality descent rather
    // than halving the longest edge (or dropping at the floor).
    let lastEdge = 0;
    let lastQuality = 100;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = (opts: { width: number }) => {
        lastEdge = opts.width;
        return pipeline;
      };
      pipeline.jpeg = (opts: { quality: number }) => {
        lastQuality = opts.quality;
        return pipeline;
      };
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'jpeg' });
      pipeline.toBuffer = async () => {
        // Over the 5 MiB cap while quality stays high; fits once quality ≤ 60.
        const sz = lastQuality > 60 ? 6 * 1024 * 1024 : 1024;
        return { data: Buffer.alloc(sz, 0x42), info: { width: lastEdge, height: lastEdge } };
      };
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    // 8192²/750 ≈ 89K tokens > 30K budget → enters the loop; the first halving to
    // 4096² ≈ 22K token-fits, so the byte cap becomes the binding constraint,
    // resolved by lowering quality at that edge rather than halving further.
    const res = await fit(base64OfBytes(4 * 1024 * 1024), 'image/jpeg', 30_000, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('downscaled');
    if (res.kind === 'downscaled') {
      expect(Buffer.from(res.data, 'base64').byteLength).toBeLessThanOrEqual(5 * 1024 * 1024);
      expect(res.note).toMatch(/quality/i);
    }
    // Quality was pushed to/under the fitting threshold, never below the floor.
    expect(lastQuality).toBeLessThanOrEqual(60);
    expect(lastQuality).toBeGreaterThanOrEqual(40);
  });

  it('replaces a downscaled image 1:1 (no extra note part) to respect the part cap', async () => {
    let currentEdge = 8192;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = (opts: { width: number }) => {
        currentEdge = opts.width;
        return pipeline;
      };
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'png' });
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: currentEdge, height: currentEdge } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitModelContentToBudget: fit } = await import('../media-fit');
    const res = await fit([{ type: 'image' as const, data: base64OfBytes(4 * 1024 * 1024), mediaType: 'image/png' }], 60_000, {
      enabled: true,
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
      reserveTokens: 0,
    });
    // One image in → exactly one image out (no separate text-note part).
    expect(res.parts).toHaveLength(1);
    expect(res.parts[0].type).toBe('image');
    expect(res.changed).toBe(true);
  });

  it('re-encodes an alpha-bearing WebP as PNG (not JPEG) to preserve transparency', async () => {
    let jpegCalled = false;
    let pngCalled = false;
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = () => pipeline;
      pipeline.jpeg = () => {
        jpegCalled = true;
        return pipeline;
      };
      pipeline.png = () => {
        pngCalled = true;
        return pipeline;
      };
      // WebP WITH alpha — must NOT be flattened to JPEG.
      pipeline.metadata = async () => ({ width: 8192, height: 8192, format: 'webp', hasAlpha: true });
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: 1024, height: 1024 } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));

    const { fitImagePart: fit } = await import('../media-fit');
    const res = await fit(base64OfBytes(4 * 1024 * 1024), 'image/webp', 60_000, {
      strategy: 'downscale',
      minDimension: 256,
      minQuality: 40,
    });
    expect(res.kind).toBe('downscaled');
    if (res.kind === 'downscaled') expect(res.mediaType).toBe('image/png');
    expect(pngCalled).toBe(true);
    expect(jpegCalled).toBe(false);
  });

  it('enforces the 12 MiB aggregate media cap (drops the part that would cross it)', async () => {
    // Mock sharp so images are "measured" small (fit tokens + individually valid),
    // but each carries ~5 MiB of decoded bytes. Three such images exceed the 12 MiB
    // downstream aggregate — the third must DROP here (loud) not silently downstream.
    const makePipeline = () => {
      const pipeline: Record<string, unknown> = {};
      pipeline.rotate = () => pipeline;
      pipeline.resize = () => pipeline;
      pipeline.jpeg = () => pipeline;
      pipeline.png = () => pipeline;
      pipeline.metadata = async () => ({ width: 256, height: 256, format: 'png' });
      pipeline.toBuffer = async () => ({ data: Buffer.alloc(64, 0x42), info: { width: 256, height: 256 } });
      return pipeline;
    };
    vi.doMock('sharp', () => ({ default: () => makePipeline() }));
    const { fitModelContentToBudget: fit } = await import('../media-fit');
    const fiveMiB = Buffer.alloc(5 * 1024 * 1024, 0x41).toString('base64');
    const parts = [
      { type: 'image' as const, data: fiveMiB, mediaType: 'image/png' },
      { type: 'image' as const, data: fiveMiB, mediaType: 'image/png' },
      { type: 'image' as const, data: fiveMiB, mediaType: 'image/png' },
    ];
    const res = await fit(parts, 10_000_000, { ...CONFIG });
    // First two fit under 12 MiB; the third crosses it → dropped with a note.
    const keptImages = res.parts.filter((p) => p.type === 'image').length;
    expect(keptImages).toBeLessThanOrEqual(2);
    expect(res.dropped).toBe(true);
  });
});

describe('stripBranchMediaForCount (sanitizer-aware retention for the whole-request seed)', () => {
  const modelContentResult = (parts: unknown[]) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool-call', toolCallId: 't', toolName: 'x', args: {}, result: { _modelContent: parts } }],
  });

  it('counts a retained (under-5-MiB) image toward retainedMediaBytes', async () => {
    const branch = [modelContentResult([{ type: 'image', data: base64OfBytes(2 * 1024 * 1024), mediaType: 'image/png' }])];
    const { retainedMediaBytes } = await stripBranchMediaForCount(branch);
    expect(retainedMediaBytes).toBeGreaterThan(1.5 * 1024 * 1024);
    expect(retainedMediaBytes).toBeLessThan(2.5 * 1024 * 1024);
  });

  it('does NOT count media the sanitizer would drop (over the 5 MiB per-part cap)', async () => {
    // Two ~5.1 MiB images: each exceeds MAX_PART_BYTES → sanitizer omits both →
    // retainedMediaBytes must be ~0 (they never reach the provider), so they do not
    // seed the whole-request ceiling and can't cause a new small image to be dropped.
    const big = base64OfBytes(Math.floor(5.1 * 1024 * 1024));
    const branch = [
      modelContentResult([
        { type: 'image', data: big, mediaType: 'image/png' },
        { type: 'image', data: big, mediaType: 'image/png' },
      ]),
    ];
    const { retainedMediaBytes, stripped } = await stripBranchMediaForCount(branch);
    expect(retainedMediaBytes).toBe(0);
    // The sanitizer REPLACES over-limit media with a model-visible omission note (it
    // doesn't silently discard), so the stripped projection must retain that note text
    // for the token count — mirror it.
    const serialized = JSON.stringify(stripped);
    expect(serialized).toMatch(/exceeds the per-result media limit/);
  });

  it('stops counting once the 12 MiB per-result total is reached', async () => {
    // Three ~4.5 MiB images in ONE result: first two (~9 MiB) retained, the third
    // crosses the 12 MiB per-result total → dropped by the sanitizer, not counted.
    const img = () => ({ type: 'image' as const, data: base64OfBytes(Math.floor(4.5 * 1024 * 1024)), mediaType: 'image/png' });
    const branch = [modelContentResult([img(), img(), img()])];
    const { retainedMediaBytes } = await stripBranchMediaForCount(branch);
    expect(retainedMediaBytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(retainedMediaBytes).toBeLessThan(12 * 1024 * 1024);
  });

  it("counts a LARGE (over-5-MiB) TOP-LEVEL user attachment fully — not subject to the _modelContent 5 MiB cap", async () => {
    // A top-level user image over 5 MiB is forwarded to the provider as-is (the
    // sanitizer cap only applies to _modelContent tool media), so it MUST be counted.
    const branch = [{ role: "user", content: [{ type: "image", data: base64OfBytes(6 * 1024 * 1024), mediaType: "image/jpeg" }] }];
    const { retainedMediaBytes } = await stripBranchMediaForCount(branch);
    expect(retainedMediaBytes).toBeGreaterThan(5.5 * 1024 * 1024);
  });

  it("leaves an un-rehydrated kai-media:// URL part UNTOUCHED (never miscounts the URL string as base64)", async () => {
    // Defense-in-depth: if an offloaded URL reaches accounting un-rehydrated, it must
    // NOT be stripped + counted as ~40 base64 bytes (which would inflate the budget).
    const branch = [
      { role: "user", content: [{ type: "image", image: "kai-media://images/deadbeef00000000.png", mimeType: "image/png" }] },
    ];
    const { stripped, retainedMediaBytes } = await stripBranchMediaForCount(branch);
    // The URL part is untouched (not stripped to a placeholder) and contributes ~0 counted bytes.
    const part = (stripped[0] as { content: Array<Record<string, unknown>> }).content[0];
    expect(part.image).toBe("kai-media://images/deadbeef00000000.png");
    expect(part._mediaStripped).toBeUndefined();
    expect(retainedMediaBytes).toBe(0);
  });

  it("does NOT count sanitizer-INVALID _modelContent media (missing mediaType)", async () => {
    // A file part with no mediaType is discarded by extractModelContent before the
    // provider call, so it must not be charged toward the seed.
    const branch = [modelContentResult([{ type: "file", data: base64OfBytes(2 * 1024 * 1024) }])];
    const { retainedMediaBytes } = await stripBranchMediaForCount(branch);
    expect(retainedMediaBytes).toBe(0);
  });

  it("does NOT add native tokens for _modelContent media the sanitizer drops (over 5 MiB)", async () => {
    const big = base64OfBytes(Math.floor(5.1 * 1024 * 1024));
    const branch = [modelContentResult([{ type: "image", data: big, mediaType: "image/png" }])];
    const { nativeMediaTokens, retainedMediaBytes } = await stripBranchMediaForCount(branch);
    // Dropped by the sanitizer → neither counted as bytes nor charged native tokens.
    expect(retainedMediaBytes).toBe(0);
    expect(nativeMediaTokens).toBe(0);
  });
});
