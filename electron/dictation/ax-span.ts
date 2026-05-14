export type AxDictationSpan = {
  location: number;
  typedUtf16Length: number;
  pid: number | null;
  elementSignature: string;
};

export function createAxDictationSpanFromSelection(
  location: unknown,
  length: unknown,
  pid: number | null,
  elementSignature: unknown,
): AxDictationSpan | null {
  if (
    typeof location !== 'number'
    || typeof length !== 'number'
    || typeof elementSignature !== 'string'
    || !Number.isFinite(location)
    || !Number.isFinite(length)
    || !Number.isInteger(location)
    || !Number.isInteger(length)
    || location < 0
    || length < 0
    || elementSignature.trim().length === 0
  ) {
    return null;
  }

  return {
    location,
    typedUtf16Length: length,
    pid,
    elementSignature,
  };
}

export type AxSelectionState = {
  location: number;
  length: number;
  elementSignature: string;
};

export function selectionMatchesDictationElement(
  span: AxDictationSpan,
  selection: AxSelectionState,
): boolean {
  return selection.elementSignature === span.elementSignature;
}

export function selectionMatchesDictationStart(
  span: AxDictationSpan,
  selection: AxSelectionState,
  currentTextUtf16Length: number,
): boolean {
  if (!selectionMatchesDictationElement(span, selection)) return false;
  if (currentTextUtf16Length === 0 && span.typedUtf16Length > 0) {
    return selection.location === span.location && selection.length === span.typedUtf16Length;
  }

  return selection.location === span.location + currentTextUtf16Length && selection.length === 0;
}

export function selectionMatchesDictationEnd(
  span: AxDictationSpan,
  selection: AxSelectionState,
  targetTextUtf16Length: number,
): boolean {
  if (!selectionMatchesDictationElement(span, selection)) return false;
  return selection.location === span.location + targetTextUtf16Length && selection.length === 0;
}
