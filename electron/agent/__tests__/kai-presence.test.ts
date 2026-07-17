import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks are hoisted; use mutable holders the tests flip per-case.
const state = {
  isActive: false as boolean | undefined,
  focusedWindow: null as unknown,
  clients: new Set<object>(),
  activityMs: new Map<object, number>(),
};

vi.mock('electron', () => ({
  app: {
    isActive: () => state.isActive,
  },
  BrowserWindow: {
    getFocusedWindow: () => state.focusedWindow,
  },
}));

vi.mock('../../local-bridge/local-clients.js', () => ({
  get localClients() {
    return state.clients;
  },
  msSinceActivity: (s: object) => state.activityMs.get(s) ?? Infinity,
}));

import {
  normalizeApprovalWindowMode,
  shouldPopOutApproval,
  resolveApprovalPopOut,
  isKaiPresent,
  isCliPresent,
  isGuiFocused,
} from '../kai-presence.js';

beforeEach(() => {
  state.isActive = false;
  state.focusedWindow = null;
  state.clients = new Set();
  state.activityMs = new Map();
});

describe('normalizeApprovalWindowMode', () => {
  it('passes through the 3-way string values', () => {
    expect(normalizeApprovalWindowMode('auto')).toBe('auto');
    expect(normalizeApprovalWindowMode('always')).toBe('always');
    expect(normalizeApprovalWindowMode('never')).toBe('never');
  });
  it('maps legacy boolean true → always, everything else → auto', () => {
    expect(normalizeApprovalWindowMode(true)).toBe('always');
    expect(normalizeApprovalWindowMode(false)).toBe('auto');
    expect(normalizeApprovalWindowMode(undefined)).toBe('auto');
    expect(normalizeApprovalWindowMode('nonsense')).toBe('auto');
  });
});

describe('presence detection', () => {
  it('isGuiFocused true when app.isActive()', () => {
    state.isActive = true;
    expect(isGuiFocused()).toBe(true);
  });
  it('isGuiFocused true when a BrowserWindow is focused', () => {
    state.isActive = false;
    state.focusedWindow = {};
    expect(isGuiFocused()).toBe(true);
  });
  it('isGuiFocused false when neither', () => {
    expect(isGuiFocused()).toBe(false);
  });

  it('isCliPresent true only for a recently-active client', () => {
    const sock = {};
    state.clients = new Set([sock]);
    state.activityMs.set(sock, 5_000); // 5s ago
    expect(isCliPresent()).toBe(true);
  });
  it('isCliPresent false for a stale client', () => {
    const sock = {};
    state.clients = new Set([sock]);
    state.activityMs.set(sock, 5 * 60_000); // 5 min ago
    expect(isCliPresent()).toBe(false);
  });
  it('isCliPresent false with no clients', () => {
    expect(isCliPresent()).toBe(false);
  });

  it('isKaiPresent is the OR of GUI focus and CLI presence', () => {
    expect(isKaiPresent()).toBe(false);
    state.isActive = true;
    expect(isKaiPresent()).toBe(true);
  });
});

describe('shouldPopOutApproval', () => {
  it('flag true → always pop out regardless of presence', () => {
    state.isActive = true;
    expect(shouldPopOutApproval(true)).toBe(true);
  });
  it('flag false → never pop out regardless of presence', () => {
    expect(shouldPopOutApproval(false)).toBe(false);
  });
  it('flag undefined → presence-aware (pop out only when NOT present)', () => {
    state.isActive = true;
    expect(shouldPopOutApproval(undefined)).toBe(false);
    state.isActive = false;
    expect(shouldPopOutApproval(undefined)).toBe(true);
  });
});

describe('resolveApprovalPopOut (config value → decision)', () => {
  it("'always' pops out even when present", () => {
    state.isActive = true;
    expect(resolveApprovalPopOut('always')).toBe(true);
  });
  it("'never' stays inline even when absent", () => {
    expect(resolveApprovalPopOut('never')).toBe(false);
  });
  it("'auto'/legacy: inline when present, pop out when absent", () => {
    state.isActive = true;
    expect(resolveApprovalPopOut('auto')).toBe(false);
    expect(resolveApprovalPopOut(false)).toBe(false);
    state.isActive = false;
    expect(resolveApprovalPopOut('auto')).toBe(true);
    expect(resolveApprovalPopOut(undefined)).toBe(true);
  });
  it("legacy true → 'always'", () => {
    state.isActive = true;
    expect(resolveApprovalPopOut(true)).toBe(true);
  });
});
