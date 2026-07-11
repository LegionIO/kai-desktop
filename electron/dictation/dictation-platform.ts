/**
 * Dictation platform seam (#82, ADR-0005).
 *
 * A thin, pure description of how dictation inserts text on a given platform.
 * This slice adds ONE consultation point (in `startDictation`) so
 * "dictation anywhere" (inserting into any app's focused native field) is
 * honestly refused where it isn't supported yet, instead of silently
 * degrading. The ~13 existing inline `process.platform === 'darwin'` guards in
 * dictation-manager are intentionally left untouched here so macOS behavior is
 * provably unchanged; folding them behind this seam is a deferred follow-up.
 */

export type DictationInsertionMode =
  /** Insert into the focused native field of any app via accessibility APIs. */
  | 'native-ax'
  /** Only the in-app composer can receive dictated text. */
  | 'composer-only'
  /** Dictation not available at all. */
  | 'unsupported';

export interface DictationPlatform {
  readonly insertionMode: DictationInsertionMode;
  /** True when transcribed text can be inserted into any app's focused field. */
  supportsAnywhereInsertion(): boolean;
}

class MacosDictationPlatform implements DictationPlatform {
  readonly insertionMode: DictationInsertionMode = 'native-ax';
  supportsAnywhereInsertion(): boolean {
    return true;
  }
}

class WindowsDictationPlatform implements DictationPlatform {
  readonly insertionMode: DictationInsertionMode = 'unsupported';
  supportsAnywhereInsertion(): boolean {
    return false;
  }
}

class LinuxDictationPlatform implements DictationPlatform {
  readonly insertionMode: DictationInsertionMode = 'unsupported';
  supportsAnywhereInsertion(): boolean {
    return false;
  }
}

/** Resolve the dictation platform seam for a platform. Pure. */
export function getDictationPlatform(platform: NodeJS.Platform = process.platform): DictationPlatform {
  switch (platform) {
    case 'darwin':
      return new MacosDictationPlatform();
    case 'win32':
      return new WindowsDictationPlatform();
    default:
      return new LinuxDictationPlatform();
  }
}
