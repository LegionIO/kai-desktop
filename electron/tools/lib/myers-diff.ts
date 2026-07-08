/**
 * Minimal line-based Myers diff producing git-style unified-diff hunks.
 *
 * Vendored because npmjs.org is blocked on the corporate network and no
 * `diff` / `jsdiff` / `diff-match-patch` dependency is present. The
 * implementation is O(ND) Myers greedy with a hard cap on edit distance;
 * beyond the cap it falls back to a whole-file replace hunk so pathological
 * inputs don't hang the main process.
 */

export type DiffLine = { type: 'context' | 'add' | 'del'; text: string };

export type UnifiedHunk = {
  aStart: number;
  aCount: number;
  bStart: number;
  bCount: number;
  lines: DiffLine[];
};

export type UnifiedDiffResult = {
  hunks: UnifiedHunk[];
  additions: number;
  deletions: number;
  unified: string;
};

const MAX_EDIT_DISTANCE = 20_000;

function splitLines(s: string): string[] {
  // Keep behaviour stable: an empty string is zero lines, not one empty line.
  if (s.length === 0) return [];
  const lines = s.split('\n');
  // A trailing newline produces a trailing empty element — drop it so line
  // counts match `wc -l` semantics.
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Myers greedy diff. Returns the full edit script as add/del/context lines.
 * Falls back to a block replacement when D exceeds {@link MAX_EDIT_DISTANCE}.
 */
function myersLines(a: string[], b: string[]): DiffLine[] {
  const N = a.length;
  const M = b.length;
  if (N === 0 && M === 0) return [];
  if (N === 0) return b.map((text) => ({ type: 'add' as const, text }));
  if (M === 0) return a.map((text) => ({ type: 'del' as const, text }));

  const max = N + M;
  const cap = Math.min(max, MAX_EDIT_DISTANCE);
  const offset = cap;
  const size = 2 * cap + 1;
  const v = new Int32Array(size);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  let solvedD = -1;
  outer: for (let d = 0; d <= cap; d++) {
    const snapshot = new Int32Array(size);
    for (let k = -d; k <= d; k += 2) {
      const idx = offset + k;
      let x: number;
      if (k === -d || (k !== d && v[idx - 1] < v[idx + 1])) {
        x = v[idx + 1];
      } else {
        x = v[idx - 1] + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[idx] = x;
      snapshot[idx] = x;
      if (x >= N && y >= M) {
        trace.push(snapshot);
        solvedD = d;
        break outer;
      }
    }
    trace.push(snapshot);
  }

  if (solvedD < 0) {
    // Edit distance exceeded cap — fall back to full replace.
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  // Backtrack.
  const script: DiffLine[] = [];
  let x = N;
  let y = M;
  for (let d = solvedD; d > 0; d--) {
    const vPrev = trace[d - 1];
    const k = x - y;
    const idx = offset + k;
    let prevK: number;
    if (k === -d || (k !== d && vPrev[idx - 1] < vPrev[idx + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vPrev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push({ type: 'context', text: a[x - 1] });
      x--;
      y--;
    }
    if (x === prevX) {
      script.push({ type: 'add', text: b[y - 1] });
      y--;
    } else {
      script.push({ type: 'del', text: a[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    script.push({ type: 'context', text: a[x - 1] });
    x--;
    y--;
  }
  script.reverse();
  return script;
}

/** Collapse a full edit script into unified-diff hunks with N context lines. */
function toHunks(script: DiffLine[], context: number): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  let aLine = 1;
  let bLine = 1;
  let i = 0;

  while (i < script.length) {
    // Skip leading context until we're within `context` lines of a change.
    let scan = i;
    while (scan < script.length && script[scan].type === 'context') scan++;
    if (scan === script.length) break;

    const leadStart = Math.max(i, scan - context);
    // Advance a/b line counters over the fully-skipped context.
    for (let s = i; s < leadStart; s++) {
      aLine++;
      bLine++;
    }

    const hunk: UnifiedHunk = { aStart: aLine, aCount: 0, bStart: bLine, bCount: 0, lines: [] };
    let j = leadStart;
    let trailingContext = 0;
    while (j < script.length) {
      const line = script[j];
      if (line.type === 'context') {
        hunk.lines.push(line);
        hunk.aCount++;
        hunk.bCount++;
        aLine++;
        bLine++;
        trailingContext++;
        // Close the hunk once we've seen 2*context+1 context lines and no
        // change follows within `context` — matches git's coalescing rule.
        if (trailingContext > context) {
          let peek = j + 1;
          let ctxAhead = 0;
          while (peek < script.length && script[peek].type === 'context' && ctxAhead < context) {
            peek++;
            ctxAhead++;
          }
          if (peek >= script.length || script[peek].type === 'context') {
            // Trim excess trailing context back to exactly `context` lines.
            const excess = trailingContext - context;
            for (let e = 0; e < excess; e++) {
              hunk.lines.pop();
              hunk.aCount--;
              hunk.bCount--;
              aLine--;
              bLine--;
            }
            j = j + 1 - excess;
            break;
          }
        }
      } else {
        trailingContext = 0;
        hunk.lines.push(line);
        if (line.type === 'del') {
          hunk.aCount++;
          aLine++;
        } else {
          hunk.bCount++;
          bLine++;
        }
      }
      j++;
    }
    hunks.push(hunk);
    i = j;
  }

  return hunks;
}

function formatHunk(h: UnifiedHunk): string {
  const aStart = h.aCount === 0 ? Math.max(0, h.aStart - 1) : h.aStart;
  const bStart = h.bCount === 0 ? Math.max(0, h.bStart - 1) : h.bStart;
  const header = `@@ -${aStart},${h.aCount} +${bStart},${h.bCount} @@`;
  const body = h.lines
    .map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)
    .join('\n');
  return header + '\n' + body;
}

export function computeUnifiedDiff(
  original: string,
  current: string,
  opts: { path?: string; context?: number } = {},
): UnifiedDiffResult {
  const context = opts.context ?? 3;
  const a = splitLines(original);
  const b = splitLines(current);
  const script = myersLines(a, b);
  const hunks = toHunks(script, context);

  let additions = 0;
  let deletions = 0;
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }

  const header = opts.path ? `--- a/${opts.path}\n+++ b/${opts.path}\n` : '';
  const unified = hunks.length === 0 ? '' : header + hunks.map(formatHunk).join('\n');

  return { hunks, additions, deletions, unified };
}

/** Parse a unified-diff string back into hunks for rendering. */
export function parseUnifiedDiff(unified: string): UnifiedHunk[] {
  if (!unified) return [];
  const lines = unified.split('\n');
  const hunks: UnifiedHunk[] = [];
  let current: UnifiedHunk | null = null;
  const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const raw of lines) {
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue;
    const m = HUNK_RE.exec(raw);
    if (m) {
      current = {
        aStart: Number(m[1]),
        aCount: m[2] != null ? Number(m[2]) : 1,
        bStart: Number(m[3]),
        bCount: m[4] != null ? Number(m[4]) : 1,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('+')) current.lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) current.lines.push({ type: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) current.lines.push({ type: 'context', text: raw.slice(1) });
    else if (raw === '') current.lines.push({ type: 'context', text: '' });
  }
  return hunks;
}
