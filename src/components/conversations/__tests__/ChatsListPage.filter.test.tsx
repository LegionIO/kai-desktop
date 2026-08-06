/**
 * Pure-logic tests for the chats-list advanced FilterPopover predicate
 * (`matchesAdvancedFilter`). The predicate is what turns the FilterPopover
 * criteria into the visible-conversation set the delete-all / delete-filtered
 * actions operate on, so keep it exercised independently of the React tree.
 */
import { describe, it, expect } from 'vitest';
import { matchesAdvancedFilter } from '../ChatsListPage';
import { DEFAULT_FILTER, type FilterPreference } from '../useConversationPreferences';

type Summary = Parameters<typeof matchesAdvancedFilter>[0];

function makeSummary(overrides: Partial<Summary> = {}): Summary {
  return {
    id: 's1',
    title: 'Chat',
    fallbackTitle: null,
    createdAt: '2026-02-10T12:00:00.000Z',
    updatedAt: '2026-02-15T12:00:00.000Z',
    lastMessageAt: '2026-02-15T12:00:00.000Z',
    messageCount: 10,
    userMessageCount: 5,
    runStatus: 'idle',
    hasUnread: false,
    lastAssistantUpdateAt: '2026-02-15T12:00:00.000Z',
    archived: false,
    workspaceId: undefined,
    hasToolCalls: false,
    hasComputerUse: false,
    hasMedia: false,
    ...overrides,
  } as Summary;
}

function filter(overrides: Partial<FilterPreference>): FilterPreference {
  return { ...DEFAULT_FILTER, ...overrides };
}

describe('matchesAdvancedFilter', () => {
  it('passes everything when no filter is active', () => {
    expect(matchesAdvancedFilter(makeSummary(), DEFAULT_FILTER)).toBe(true);
  });

  it('boolean toggles require the flag to be truthy', () => {
    expect(matchesAdvancedFilter(makeSummary({ hasToolCalls: true }), filter({ hasToolCalls: true }))).toBe(true);
    expect(matchesAdvancedFilter(makeSummary({ hasToolCalls: false }), filter({ hasToolCalls: true }))).toBe(false);
    expect(matchesAdvancedFilter(makeSummary({ hasComputerUse: true }), filter({ hasComputerUse: true }))).toBe(true);
    expect(matchesAdvancedFilter(makeSummary({ hasComputerUse: false }), filter({ hasComputerUse: true }))).toBe(false);
    expect(matchesAdvancedFilter(makeSummary({ hasMedia: true }), filter({ hasMedia: true }))).toBe(true);
    expect(matchesAdvancedFilter(makeSummary({ hasMedia: false }), filter({ hasMedia: true }))).toBe(false);
  });

  it('applies inclusive message-count bounds', () => {
    expect(matchesAdvancedFilter(makeSummary({ messageCount: 10 }), filter({ messageCountMin: 10 }))).toBe(true);
    expect(matchesAdvancedFilter(makeSummary({ messageCount: 9 }), filter({ messageCountMin: 10 }))).toBe(false);
    expect(matchesAdvancedFilter(makeSummary({ messageCount: 10 }), filter({ messageCountMax: 10 }))).toBe(true);
    expect(matchesAdvancedFilter(makeSummary({ messageCount: 11 }), filter({ messageCountMax: 10 }))).toBe(false);
  });

  it('applies created/updated date bounds against the date portion', () => {
    const s = makeSummary({ createdAt: '2026-02-10T23:59:00.000Z', updatedAt: '2026-02-15T00:00:00.000Z' });
    // created 2026-02-10 — within [after 02-10, before 02-10] (whole-day inclusive)
    expect(matchesAdvancedFilter(s, filter({ createdAfter: '2026-02-10', createdBefore: '2026-02-10' }))).toBe(true);
    expect(matchesAdvancedFilter(s, filter({ createdAfter: '2026-02-11' }))).toBe(false);
    expect(matchesAdvancedFilter(s, filter({ createdBefore: '2026-02-09' }))).toBe(false);
    // updated uses lastAssistantUpdateAt ?? lastMessageAt ?? updatedAt
    expect(matchesAdvancedFilter(s, filter({ updatedAfter: '2026-02-15' }))).toBe(true);
    expect(matchesAdvancedFilter(s, filter({ updatedBefore: '2026-02-14' }))).toBe(false);
  });

  it('requires ALL active criteria to match', () => {
    const s = makeSummary({ hasMedia: true, messageCount: 3 });
    expect(matchesAdvancedFilter(s, filter({ hasMedia: true, messageCountMin: 5 }))).toBe(false);
    expect(matchesAdvancedFilter(s, filter({ hasMedia: true, messageCountMin: 2 }))).toBe(true);
  });
});
