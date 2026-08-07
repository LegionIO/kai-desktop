import { useMemo, useCallback, useSyncExternalStore } from 'react';

export type SortField = 'latest-updated' | 'first-created' | 'alphabetical';
export type SortDirection = 'asc' | 'desc';
export type SortPreference = { field: SortField; direction: SortDirection };

export type FilterPreference = {
  hasToolCalls: boolean | null;
  hasComputerUse: boolean | null;
  hasMedia: boolean | null;
  messageCountMin: number | null;
  messageCountMax: number | null;
  createdAfter: string | null;
  createdBefore: string | null;
  updatedAfter: string | null;
  updatedBefore: string | null;
};

export const DEFAULT_SORT: SortPreference = { field: 'latest-updated', direction: 'desc' };

export const DEFAULT_FILTER: FilterPreference = {
  hasToolCalls: null,
  hasComputerUse: null,
  hasMedia: null,
  messageCountMin: null,
  messageCountMax: null,
  createdAfter: null,
  createdBefore: null,
  updatedAfter: null,
  updatedBefore: null,
};

const SORT_KEY = __BRAND_APP_SLUG + ':conversation-sort';
const FILTER_KEY = __BRAND_APP_SLUG + ':conversation-filter';

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

// Module-level shared store. Multiple mounts of useConversationPreferences (e.g. the
// sidebar ConversationList and the Chats page) must observe the SAME preferences and
// re-render together when either one changes. Two independent useState instances did not:
// writing localStorage does not notify other components in the same window (the `storage`
// event only fires in OTHER tabs/windows). Backing the hook with a shared external store +
// useSyncExternalStore gives every mount one source of truth with same-window updates.
let sortState: SortPreference = load(SORT_KEY, DEFAULT_SORT);
let filterState: FilterPreference = load(FILTER_KEY, DEFAULT_FILTER);
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function emit(): void {
  for (const l of listeners) l();
}

function setSort(next: SortPreference | ((prev: SortPreference) => SortPreference)): void {
  sortState = typeof next === 'function' ? (next as (p: SortPreference) => SortPreference)(sortState) : next;
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(sortState));
  } catch {
    /* persistence best-effort */
  }
  emit();
}
function setFilter(next: FilterPreference | ((prev: FilterPreference) => FilterPreference)): void {
  filterState =
    typeof next === 'function' ? (next as (p: FilterPreference) => FilterPreference)(filterState) : next;
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filterState));
  } catch {
    /* persistence best-effort */
  }
  emit();
}

// Cross-window sync: adopt preferences changed by OTHER windows so all windows converge.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === SORT_KEY) {
      sortState = load(SORT_KEY, DEFAULT_SORT);
      emit();
    } else if (e.key === FILTER_KEY) {
      filterState = load(FILTER_KEY, DEFAULT_FILTER);
      emit();
    }
  });
}

export function useConversationPreferences() {
  const sort = useSyncExternalStore(subscribe, () => sortState);
  const filter = useSyncExternalStore(subscribe, () => filterState);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filter.hasToolCalls != null) count++;
    if (filter.hasComputerUse != null) count++;
    if (filter.hasMedia != null) count++;
    if (filter.messageCountMin != null) count++;
    if (filter.messageCountMax != null) count++;
    if (filter.createdAfter) count++;
    if (filter.createdBefore) count++;
    if (filter.updatedAfter) count++;
    if (filter.updatedBefore) count++;
    return count;
  }, [filter]);

  const clearFilters = useCallback(() => setFilter(DEFAULT_FILTER), []);

  const isDefaultSort = sort.field === DEFAULT_SORT.field && sort.direction === DEFAULT_SORT.direction;

  return { sort, setSort, filter, setFilter, activeFilterCount, clearFilters, isDefaultSort };
}
