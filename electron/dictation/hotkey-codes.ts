export type ParsedHotkeyCodes = {
  modifierCodes: Set<number>;
  primaryCodes: Set<number>;
};

const MODIFIER_KEYCODES: Record<string, readonly number[]> = {
  command: [55, 54],
  cmd: [55, 54],
  commandorcontrol: [55, 54],
  cmdorctrl: [55, 54],
  shift: [56, 60],
  option: [58, 61],
  alt: [58, 61],
  control: [59, 62],
  ctrl: [59, 62],
};

const PRIMARY_KEYCODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  '=': 24,
  equal: 24,
  plus: 24,
  '+': 24,
  '9': 25,
  '7': 26,
  '-': 27,
  minus: 27,
  hyphen: 27,
  '8': 28,
  '0': 29,
  ']': 30,
  rightbracket: 30,
  o: 31,
  u: 32,
  '[': 33,
  leftbracket: 33,
  i: 34,
  p: 35,
  enter: 36,
  return: 36,
  l: 37,
  j: 38,
  "'": 39,
  quote: 39,
  apostrophe: 39,
  k: 40,
  ';': 41,
  semicolon: 41,
  '\\': 42,
  backslash: 42,
  ',': 43,
  comma: 43,
  '/': 44,
  slash: 44,
  n: 45,
  m: 46,
  '.': 47,
  period: 47,
  tab: 48,
  space: 49,
  '`': 50,
  grave: 50,
  backtick: 50,
  delete: 51,
  backspace: 51,
  escape: 53,
  esc: 53,
  capslock: 57,
  function: 63,
  fn: 63,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  f13: 105,
  f14: 107,
  f15: 113,
  f16: 106,
  f17: 64,
  f18: 79,
  f19: 80,
  f20: 90,
  home: 115,
  pageup: 116,
  forwarddelete: 117,
  end: 119,
  pagedown: 121,
  left: 123,
  arrowleft: 123,
  right: 124,
  arrowright: 124,
  down: 125,
  arrowdown: 125,
  up: 126,
  arrowup: 126,
};

function splitHotkeyParts(hotkey: string): string[] {
  const trimmed = hotkey.trim();
  if (trimmed.endsWith('++')) {
    return [
      ...trimmed.slice(0, -1).split('+').filter((part) => part.trim()),
      '+',
    ];
  }
  return trimmed.split('+').filter((part) => part.trim());
}

function normalizeHotkeyPart(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/g, '').replace(/-/g, '');
}

function addCodes(target: Set<number>, codes: readonly number[] | undefined): void {
  if (!codes) return;
  for (const code of codes) {
    target.add(code);
  }
}

export function parseHotkeyCodes(hotkey: string): ParsedHotkeyCodes {
  const modifierCodes = new Set<number>();
  const primaryCodes = new Set<number>();
  const parts = splitHotkeyParts(hotkey).map(normalizeHotkeyPart);
  const primary = parts.at(-1);

  for (const part of parts.slice(0, -1)) {
    addCodes(modifierCodes, MODIFIER_KEYCODES[part]);
  }

  if (primary) {
    const primaryCode = PRIMARY_KEYCODES[primary];
    if (primaryCode !== undefined) {
      primaryCodes.add(primaryCode);
    }
  }

  return { modifierCodes, primaryCodes };
}
