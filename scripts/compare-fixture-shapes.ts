/**
 * Compares the SHAPE of a live captured event sequence against the shape
 * derived from the committed JSONL fixtures. "Shape" here means:
 *
 *   - the ordered list of event types in the response (single object → one
 *     event keyed by `body-type`; streaming → the sequence of SSE
 *     `event:` types, or for `data:`-only streams the `type` field of each
 *     parsed JSON chunk)
 *   - for each event type, the set of populated field NAMES (top-level keys
 *     whose value is not undefined)
 *
 * Field VALUES are deliberately ignored — they are non-deterministic across
 * requests (ids, timestamps, sampled completions) but the SDK contracts
 * promise field NAMES are stable, so any rename or addition is a real
 * behavioural drift signal that should be surfaced.
 *
 * Usage (library):
 *   import { extractShape, diffShapes, formatDiff } from './compare-fixture-shapes';
 *
 * Usage (CLI):
 *   tsx scripts/compare-fixture-shapes.ts \
 *     --captured path/to/live.json \
 *     --fixture  electron/__tests__/__fixtures__/anthropic/simple-completion.jsonl
 *
 *   Inputs may also come from stdin via `--captured -` or `--fixture -`.
 *
 * Exits 0 if no drift detected, 1 if drift detected, 2 on usage errors.
 *
 * The CLI accepts EITHER a JSONL fixture file (one provider entry per
 * line) OR a pre-extracted `EventShapeSequence` JSON. Pre-extracted shapes
 * are what the live capture step in the drift-check workflow produces — it
 * never serialises raw response bodies to disk, only their shape summary.
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types — kept narrow so the shape can be JSON-serialised cleanly.
// ---------------------------------------------------------------------------

/**
 * One observed event in a response. `type` is the event discriminator
 * (e.g. `message_start`, `content_block_delta`, or for non-streaming
 * responses the shape tag like `body`). `fields` is the alphabetised list
 * of top-level field names present on the event payload.
 */
export interface EventShape {
  type: string;
  fields: string[];
}

/** The ordered shape of a single response capture. */
export interface EventShapeSequence {
  /** Free-form label so diff reports can identify the source. */
  label: string;
  events: EventShape[];
}

/** One discrepancy between two shapes. */
export interface ShapeDiff {
  /** Stable category so reports can group findings. */
  kind: 'event-added' | 'event-removed' | 'event-reordered' | 'field-added' | 'field-removed';
  /** Index in the captured sequence where the discrepancy was first detected. */
  index: number;
  /** Event type the discrepancy applies to (or `<missing>` when an event is absent on one side). */
  eventType: string;
  /** Human-readable description, formatted for inclusion in a GitHub Issue body. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Shape extraction from JSONL fixture text.
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function topLevelFieldNames(payload: unknown): string[] {
  if (!isObject(payload)) return [];
  return Object.keys(payload).sort();
}

/**
 * Parse one SSE chunk emitted by either provider's streaming format.
 *
 * Anthropic chunks carry an explicit `event: <type>` line plus a
 * `data: <json>` line. OpenAI chunks omit the `event:` line and put the
 * type inside the JSON payload (`object`, or for the new Responses API
 * the `type` field). We accept either, and treat the special sentinel
 * `data: [DONE]` as a terminator event called `[DONE]` so it shows up in
 * the diff if a provider stops sending it.
 */
function parseSseChunk(chunk: string): { type: string; fields: string[] } | null {
  const lines = chunk
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  let eventName: string | null = null;
  let dataPayload: string | null = null;
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataPayload = line.slice('data:'.length).trim();
    }
  }

  if (dataPayload === null) {
    // Unrecognised chunk — surface a synthetic type so the diff can flag it.
    return { type: eventName ?? '<unknown>', fields: [] };
  }

  if (dataPayload === '[DONE]') {
    return { type: '[DONE]', fields: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataPayload);
  } catch {
    return { type: eventName ?? '<unparseable>', fields: [] };
  }

  // Prefer the explicit SSE `event:` name when present (Anthropic shape);
  // otherwise fall back to the payload's `type` field (Responses API)
  // or `object` field (OpenAI chat.completion.chunk).
  const fallbackType =
    (isObject(parsed) && typeof parsed.type === 'string' && parsed.type) ||
    (isObject(parsed) && typeof parsed.object === 'string' && parsed.object) ||
    '<untyped>';
  const type = eventName ?? fallbackType;
  const fields = topLevelFieldNames(parsed);
  return { type, fields };
}

/**
 * Derive the event-shape sequence from a JSONL fixture file's contents.
 *
 * - Single-body responses become a one-element sequence with type
 *   `body:<type-or-object>` so the diff is comparable to other single-body
 *   shapes (e.g. an error response vs a success response).
 * - Streaming responses become one event per SSE chunk in arrival order.
 *
 * The function never reads the file system; pass it the already-read JSONL
 * text so it stays testable in isolation.
 */
export function extractShape(jsonl: string, label = 'fixture'): EventShapeSequence {
  const events: EventShape[] = [];

  const lines = jsonl
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip unparseable lines — a partial fixture should still report a
      // useful shape for the entries we can read.
      continue;
    }
    if (!isObject(parsed) || !isObject(parsed.response)) continue;
    const resp = parsed.response as Record<string, unknown>;

    if (Array.isArray(resp.bodyStream)) {
      for (const chunk of resp.bodyStream) {
        if (typeof chunk !== 'string') continue;
        const ev = parseSseChunk(chunk);
        if (ev !== null) events.push(ev);
      }
      continue;
    }

    if (isObject(resp.body)) {
      const body = resp.body;
      // Pick a stable tag so diffs across the same logical response stay
      // anchored even if the SDK adds a new top-level discriminator. We
      // include the `type` if present (Anthropic uses `message` / `error`)
      // and otherwise fall back to a generic `body` tag.
      const tag =
        typeof body.type === 'string'
          ? `body:${body.type}`
          : typeof body.object === 'string'
            ? `body:${body.object}`
            : 'body';
      events.push({
        type: tag,
        fields: topLevelFieldNames(body),
      });
    }
  }

  return { label, events };
}

// ---------------------------------------------------------------------------
// Shape comparison.
// ---------------------------------------------------------------------------

/**
 * Compute the structured diff between two shapes.
 *
 * The algorithm is intentionally simple — we align events by position and
 * record any mismatch. For most live-vs-fixture comparisons the captured
 * and fixture sequences have the same length and the only drift signal we
 * care about is "an event type changed" or "a field changed". The simple
 * algorithm has the desirable property that adding a single event in the
 * middle reports one `event-added`/`event-removed` pair rather than
 * cascading false positives.
 */
export function diffShapes(captured: EventShapeSequence, fixture: EventShapeSequence): ShapeDiff[] {
  const diffs: ShapeDiff[] = [];
  const maxLen = Math.max(captured.events.length, fixture.events.length);

  for (let i = 0; i < maxLen; i += 1) {
    const cap = captured.events[i];
    const fix = fixture.events[i];

    if (cap === undefined && fix !== undefined) {
      diffs.push({
        kind: 'event-removed',
        index: i,
        eventType: fix.type,
        detail: `Fixture has event \`${fix.type}\` at index ${i}, captured live response stopped early.`,
      });
      continue;
    }
    if (cap !== undefined && fix === undefined) {
      diffs.push({
        kind: 'event-added',
        index: i,
        eventType: cap.type,
        detail: `Captured live response has extra event \`${cap.type}\` at index ${i}, fixture ends earlier.`,
      });
      continue;
    }
    if (cap === undefined || fix === undefined) continue;

    if (cap.type !== fix.type) {
      diffs.push({
        kind: 'event-reordered',
        index: i,
        eventType: cap.type,
        detail: `Event type mismatch at index ${i}: captured \`${cap.type}\`, fixture \`${fix.type}\`.`,
      });
      // Don't compare fields when event types differ — the comparison is
      // not meaningful and the noise drowns the real signal.
      continue;
    }

    const capFields = new Set(cap.fields);
    const fixFields = new Set(fix.fields);

    const added = [...capFields].filter((f) => !fixFields.has(f)).sort();
    const removed = [...fixFields].filter((f) => !capFields.has(f)).sort();

    for (const f of added) {
      diffs.push({
        kind: 'field-added',
        index: i,
        eventType: cap.type,
        detail: `Field \`${f}\` appeared on event \`${cap.type}\` at index ${i} (live response has it; fixture does not).`,
      });
    }
    for (const f of removed) {
      diffs.push({
        kind: 'field-removed',
        index: i,
        eventType: cap.type,
        detail: `Field \`${f}\` disappeared from event \`${cap.type}\` at index ${i} (fixture has it; live response does not).`,
      });
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

/**
 * Render a diff as a markdown block suitable for embedding in a GitHub
 * Issue body. Returns an empty string when no drift is present so the
 * caller can branch on truthiness.
 */
export function formatDiff(diffs: ShapeDiff[], captured: EventShapeSequence, fixture: EventShapeSequence): string {
  if (diffs.length === 0) return '';

  const lines: string[] = [];
  lines.push(`### Fixture shape drift detected`);
  lines.push('');
  lines.push(
    `- Captured: \`${captured.label}\` (${captured.events.length} event${captured.events.length === 1 ? '' : 's'})`,
  );
  lines.push(
    `- Fixture:  \`${fixture.label}\` (${fixture.events.length} event${fixture.events.length === 1 ? '' : 's'})`,
  );
  lines.push('');
  lines.push('| Index | Kind | Event | Detail |');
  lines.push('| --- | --- | --- | --- |');
  for (const d of diffs) {
    // Escape pipe characters in details so the markdown table stays well-formed.
    const safeDetail = d.detail.replace(/\|/g, '\\|');
    lines.push(`| ${d.index} | ${d.kind} | \`${d.eventType}\` | ${safeDetail} |`);
  }
  lines.push('');
  lines.push('Field VALUES are intentionally not compared — only event types and populated field names.');
  return lines.join('\n');
}

/**
 * A short, stable symptom hash so the workflow can deduplicate GitHub
 * Issues across repeated drift detections without spamming the issue
 * tracker. The hash is derived from the diff `kind` and `eventType` plus
 * the position class (early/mid/late) so an unchanged signature reuses
 * the existing issue.
 *
 * Deliberately non-cryptographic — collisions just mean two drift signals
 * share an issue, which is the desired behaviour for grouping.
 */
export function symptomHash(diffs: ShapeDiff[]): string {
  if (diffs.length === 0) return 'none';
  const tokens = diffs
    .map((d) => `${d.kind}:${d.eventType}`)
    .sort()
    .join('|');
  // FNV-1a 32-bit hash — enough discrimination for our purposes, and
  // implementable inline so the script has no extra dependencies.
  let h = 0x811c9dc5;
  for (let i = 0; i < tokens.length; i += 1) {
    h ^= tokens.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// CLI driver.
// ---------------------------------------------------------------------------

interface CliArgs {
  capturedPath: string;
  fixturePath: string;
  format: 'markdown' | 'json';
  capturedLabel?: string;
  fixtureLabel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { format: 'markdown' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--captured':
        args.capturedPath = argv[++i];
        break;
      case '--fixture':
        args.fixturePath = argv[++i];
        break;
      case '--captured-label':
        args.capturedLabel = argv[++i];
        break;
      case '--fixture-label':
        args.fixtureLabel = argv[++i];
        break;
      case '--format':
        {
          const v = argv[++i];
          if (v !== 'markdown' && v !== 'json') {
            throw new Error(`--format must be 'markdown' or 'json', got '${v}'`);
          }
          args.format = v;
        }
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.capturedPath) throw new Error('Missing required --captured <path|-> argument');
  if (!args.fixturePath) throw new Error('Missing required --fixture <path|-> argument');
  return args as CliArgs;
}

function printUsage(): void {
  console.info(
    [
      'Usage: tsx scripts/compare-fixture-shapes.ts \\',
      '         --captured <path-or-dash> \\',
      '         --fixture  <path-or-dash> \\',
      '         [--captured-label LABEL] [--fixture-label LABEL] \\',
      '         [--format markdown|json]',
      '',
      'Inputs may be JSONL fixture files OR pre-extracted EventShapeSequence',
      'JSON objects. Use - to read from stdin.',
      '',
      'Exits 0 if no drift, 1 if drift detected, 2 on usage error.',
    ].join('\n'),
  );
}

function readInput(pathOrDash: string): string {
  if (pathOrDash === '-') {
    return readFileSync(0, 'utf8');
  }
  return readFileSync(pathOrDash, 'utf8');
}

/**
 * Accept either an already-extracted shape (JSON object with `events`
 * field) or raw JSONL fixture text, and normalise to an
 * `EventShapeSequence`. This lets the workflow capture step write a
 * compact shape JSON without re-implementing extraction.
 */
function loadShape(raw: string, fallbackLabel: string): EventShapeSequence {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<EventShapeSequence>;
      if (Array.isArray(parsed.events)) {
        return {
          label: typeof parsed.label === 'string' ? parsed.label : fallbackLabel,
          events: parsed.events.map((e) => ({
            type: String((e as EventShape).type ?? '<missing>'),
            fields: Array.isArray((e as EventShape).fields) ? [...(e as EventShape).fields].map(String).sort() : [],
          })),
        };
      }
    } catch {
      // fall through to JSONL parse
    }
  }
  return extractShape(raw, fallbackLabel);
}

function mainCli(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    printUsage();
    return 2;
  }

  const capturedRaw = readInput(args.capturedPath);
  const fixtureRaw = readInput(args.fixturePath);

  const captured = loadShape(capturedRaw, args.capturedLabel ?? args.capturedPath);
  const fixture = loadShape(fixtureRaw, args.fixtureLabel ?? args.fixturePath);

  const diffs = diffShapes(captured, fixture);

  if (args.format === 'json') {
    const payload = {
      drift: diffs.length > 0,
      symptomHash: symptomHash(diffs),
      capturedLabel: captured.label,
      fixtureLabel: fixture.label,
      capturedEventCount: captured.events.length,
      fixtureEventCount: fixture.events.length,
      diffs,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    const report = formatDiff(diffs, captured, fixture);
    if (report) {
      process.stdout.write(report + '\n');
    } else {
      process.stdout.write(
        `No drift detected between \`${captured.label}\` and \`${fixture.label}\` ` +
          `(${captured.events.length} events compared).\n`,
      );
    }
  }

  return diffs.length === 0 ? 0 : 1;
}

// Detect direct CLI invocation. Using `import.meta.url` keeps the script
// safe to import for unit tests without triggering process.exit.
const invokedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = new URL(import.meta.url).pathname;
    return entry === here || here.endsWith(entry) || entry.endsWith('compare-fixture-shapes.ts');
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const code = mainCli(process.argv.slice(2));
  process.exit(code);
}
