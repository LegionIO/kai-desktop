export type DictationPatchPhase = 'partial' | 'final';

export type DictationPatchOperation =
  | { kind: 'moveLeft' | 'moveRight' | 'deleteForward'; count: number }
  | { kind: 'insertText'; text: string };

export type DictationPatchPlan =
  | { kind: 'none'; targetText: string }
  | { kind: 'append'; text: string; targetText: string }
  | { kind: 'patch'; operations: DictationPatchOperation[]; targetText: string }
  | { kind: 'tailRewrite'; backspaceCount: number; text: string; targetText: string };

type EditHunk = {
  start: number;
  deleteCount: number;
  insertText: string;
  insertGraphemeCount: number;
};

type SegmenterConstructor = new (
  locale?: string | string[],
  options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
) => {
  segment(input: string): Iterable<{ segment: string }>;
};

const MAX_EDIT_HUNKS = 8;
const MAX_CURSOR_MOVES = 60;
const MAX_INSERTED_GRAPHEMES = 80;
const MAX_DIFF_CELLS = 120_000;

export function splitGraphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment);
  }
  return Array.from(text);
}

export function planDictationTextPatch(
  currentText: string,
  targetText: string,
  phase: DictationPatchPhase,
): DictationPatchPlan {
  if (currentText === targetText) {
    return { kind: 'none', targetText };
  }

  if (targetText.startsWith(currentText)) {
    return { kind: 'append', text: targetText.slice(currentText.length), targetText };
  }

  const currentGraphemes = splitGraphemes(currentText);
  const targetGraphemes = splitGraphemes(targetText);

  if (currentGraphemes.length === 0) {
    return { kind: 'append', text: targetText, targetText };
  }

  if (!isPatchableChange(currentText, targetText, phase)) {
    return createTailRewritePlan(currentGraphemes, targetGraphemes, targetText);
  }

  const hunks = buildEditHunks(currentGraphemes, targetGraphemes);
  if (!hunks || hunks.length > MAX_EDIT_HUNKS) {
    return createTailRewritePlan(currentGraphemes, targetGraphemes, targetText);
  }
  if (hunks.length === 0) {
    return { kind: 'none', targetText };
  }

  const operations = buildPatchOperations(hunks, currentGraphemes.length, targetGraphemes.length);
  if (!operations) {
    return createTailRewritePlan(currentGraphemes, targetGraphemes, targetText);
  }

  const totalCursorMoves = operations.reduce((total, op) => {
    if (op.kind === 'moveLeft' || op.kind === 'moveRight') return total + op.count;
    return total;
  }, 0);
  const totalInsertedGraphemes = hunks.reduce((total, hunk) => total + hunk.insertGraphemeCount, 0);

  if (totalCursorMoves > MAX_CURSOR_MOVES || totalInsertedGraphemes > MAX_INSERTED_GRAPHEMES) {
    return createTailRewritePlan(currentGraphemes, targetGraphemes, targetText);
  }

  return { kind: 'patch', operations, targetText };
}

function isPatchableChange(currentText: string, targetText: string, phase: DictationPatchPhase): boolean {
  const normalizedCurrent = normalizeForDictationPatch(currentText);
  const normalizedTarget = normalizeForDictationPatch(targetText);

  if (normalizedCurrent === normalizedTarget) return true;

  const longest = Math.max(normalizedCurrent.length, normalizedTarget.length);
  const cappedThreshold = phase === 'partial' ? 8 : 10;
  const threshold = Math.min(cappedThreshold, Math.max(4, Math.ceil(longest * 0.22)));

  return levenshteinDistance(normalizedCurrent, normalizedTarget, threshold) <= threshold;
}

function normalizeForDictationPatch(text: string): string {
  return Array.from(text.normalize('NFKC').toLocaleLowerCase().matchAll(/[\p{Letter}\p{Number}]/gu), (match) => match[0]).join('');
}

function levenshteinDistance(a: string, b: string, maxDistance: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    let rowMin = current[0];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }

    if (rowMin > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function buildEditHunks(current: string[], target: string[]): EditHunk[] | null {
  const n = current.length;
  const m = target.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;

  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = current[i] === target[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const hunks: EditHunk[] = [];
  let active: { start: number; deleteCount: number; inserted: string[] } | null = null;
  let i = 0;
  let j = 0;

  const ensureHunk = (): { start: number; deleteCount: number; inserted: string[] } => {
    active ??= { start: i, deleteCount: 0, inserted: [] };
    return active;
  };

  const flushHunk = (): void => {
    if (!active) return;
    hunks.push({
      start: active.start,
      deleteCount: active.deleteCount,
      insertText: active.inserted.join(''),
      insertGraphemeCount: active.inserted.length,
    });
    active = null;
  };

  while (i < n || j < m) {
    if (i < n && j < m && current[i] === target[j]) {
      flushHunk();
      i++;
      j++;
      continue;
    }

    if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      ensureHunk().deleteCount++;
      i++;
      continue;
    }

    if (j < m) {
      ensureHunk().inserted.push(target[j]);
      j++;
    }
  }

  flushHunk();
  return hunks;
}

function buildPatchOperations(
  hunks: EditHunk[],
  currentLength: number,
  targetLength: number,
): DictationPatchOperation[] | null {
  const operations: DictationPatchOperation[] = [];
  let cursor = currentLength;

  for (const hunk of [...hunks].reverse()) {
    const moveLeft = cursor - hunk.start;
    if (moveLeft < 0) return null;
    pushCountOperation(operations, 'moveLeft', moveLeft);
    pushCountOperation(operations, 'deleteForward', hunk.deleteCount);
    if (hunk.insertText) {
      pushInsertOperation(operations, hunk.insertText);
    }
    cursor = hunk.start + hunk.insertGraphemeCount;
  }

  const moveRight = targetLength - cursor;
  if (moveRight < 0) return null;
  pushCountOperation(operations, 'moveRight', moveRight);
  return operations;
}

function pushCountOperation(
  operations: DictationPatchOperation[],
  kind: 'moveLeft' | 'moveRight' | 'deleteForward',
  count: number,
): void {
  if (count <= 0) return;
  const previous = operations.at(-1);
  if (previous?.kind === kind) {
    previous.count += count;
    return;
  }
  operations.push({ kind, count });
}

function pushInsertOperation(operations: DictationPatchOperation[], text: string): void {
  if (!text) return;
  const previous = operations.at(-1);
  if (previous?.kind === 'insertText') {
    previous.text += text;
    return;
  }
  operations.push({ kind: 'insertText', text });
}

function createTailRewritePlan(
  current: string[],
  target: string[],
  targetText: string,
): DictationPatchPlan {
  const commonPrefix = commonPrefixLength(current, target);
  return {
    kind: 'tailRewrite',
    backspaceCount: current.length - commonPrefix,
    text: target.slice(commonPrefix).join(''),
    targetText,
  };
}

function commonPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}
