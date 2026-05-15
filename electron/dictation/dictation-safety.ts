export function isSafeKeyboardPatchText(text: string): boolean {
  return /^[\x20-\x7E]*$/.test(text);
}

export function normalizeCleanupResponse(text: string): string {
  let cleaned = text.trim()
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (
    cleaned.length >= 2
    && ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'")))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }

  return cleaned;
}

export function isAcceptableCleanupResponse(raw: string, cleaned: string): boolean {
  if (!cleaned) return false;
  const maxLength = Math.max(raw.length + 40, Math.ceil(raw.length * 1.5));
  if (cleaned.length > maxLength) return false;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) return false;
  if (!raw.includes('\n') && cleaned.includes('\n')) return false;
  if (!raw.includes('\t') && cleaned.includes('\t')) return false;
  if (!hasAcceptableSemanticOverlap(raw, cleaned)) return false;
  return true;
}

function hasAcceptableSemanticOverlap(raw: string, cleaned: string): boolean {
  const rawTokens = semanticTokens(raw);
  const cleanedTokens = semanticTokens(cleaned);

  if (rawTokens.length === 0 || cleanedTokens.length === 0) {
    return normalizedSemanticText(raw) === normalizedSemanticText(cleaned);
  }

  const rawSet = new Set(rawTokens);
  const cleanedSet = new Set(cleanedTokens);
  let intersection = 0;
  for (const token of cleanedSet) {
    if (rawSet.has(token)) intersection += 1;
  }

  const precision = intersection / cleanedSet.size;
  const recall = intersection / rawSet.size;
  if (precision >= 0.55 && recall >= 0.45) return true;

  const rawNormalized = normalizedSemanticText(raw);
  const cleanedNormalized = normalizedSemanticText(cleaned);
  if (!rawNormalized || !cleanedNormalized) return false;
  const longest = Math.max(rawNormalized.length, cleanedNormalized.length);
  const maxDistance = Math.max(3, Math.ceil(longest * 0.35));
  return boundedLevenshteinDistance(rawNormalized, cleanedNormalized, maxDistance) <= maxDistance;
}

function semanticTokens(text: string): string[] {
  return Array.from(
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .matchAll(/[\p{Letter}\p{Number}]+/gu),
    (match) => match[0],
  );
}

function normalizedSemanticText(text: string): string {
  return semanticTokens(text).join('');
}

function boundedLevenshteinDistance(a: string, b: string, maxDistance: number): number {
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
