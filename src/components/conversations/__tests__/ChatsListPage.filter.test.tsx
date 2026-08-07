/**
 * Pure-logic tests for the chats-list advanced FilterPopover predicate
 * (`matchesAdvancedFilter`). The predicate is what turns the FilterPopover
 * criteria into the visible-conversation set the delete-all / delete-filtered
 * actions operate on, so keep it exercised independently of the React tree.
 */
import { describe, it, expect } from 'vitest';
import { matchesAdvancedFilter, localCalendarDay } from '../ChatsListPage';
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

  it('applies created/updated date bounds against the LOCAL calendar day', () => {
    // Use a mid-day-UTC timestamp and derive the expected local day from the SAME helper
    // the predicate uses, so the assertions hold regardless of the runner's timezone.
    const createdAt = '2026-02-10T12:00:00.000Z';
    const updatedAt = '2026-02-15T12:00:00.000Z';
    const s = makeSummary({
      createdAt,
      updatedAt,
      lastMessageAt: updatedAt,
      lastAssistantUpdateAt: updatedAt,
    });
    const createdDay = localCalendarDay(createdAt);
    const updatedDay = localCalendarDay(updatedAt);
    const dayBefore = (d: string) => localCalendarDay(new Date(new Date(d).getTime() - 86_400_000).toISOString());
    const dayAfter = (d: string) => localCalendarDay(new Date(new Date(d).getTime() + 86_400_000).toISOString());

    // within [after createdDay, before createdDay] (whole-day inclusive)
    expect(matchesAdvancedFilter(s, filter({ createdAfter: createdDay, createdBefore: createdDay }))).toBe(true);
    expect(matchesAdvancedFilter(s, filter({ createdAfter: dayAfter(createdAt) }))).toBe(false);
    expect(matchesAdvancedFilter(s, filter({ createdBefore: dayBefore(createdAt) }))).toBe(false);
    // updated uses lastAssistantUpdateAt ?? lastMessageAt ?? updatedAt
    expect(matchesAdvancedFilter(s, filter({ updatedAfter: updatedDay }))).toBe(true);
    expect(matchesAdvancedFilter(s, filter({ updatedBefore: dayBefore(updatedAt) }))).toBe(false);
  });

  it('localCalendarDay buckets by LOCAL day, not the UTC slice', () => {
    // The local day derived from the timestamp must match Date's local components — this is
    // what fixes the near-midnight cross-timezone mis-bucketing (UTC slice would disagree).
    const iso = '2026-08-05T23:30:00.000Z';
    const d = new Date(iso);
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(localCalendarDay(iso)).toBe(expected);
    expect(localCalendarDay(null)).toBe('');
    expect(localCalendarDay('not-a-date')).toBe('');
  });

  it('requires ALL active criteria to match', () => {
    const s = makeSummary({ hasMedia: true, messageCount: 3 });
    expect(matchesAdvancedFilter(s, filter({ hasMedia: true, messageCountMin: 5 }))).toBe(false);
    expect(matchesAdvancedFilter(s, filter({ hasMedia: true, messageCountMin: 2 }))).toBe(true);
  });
});
