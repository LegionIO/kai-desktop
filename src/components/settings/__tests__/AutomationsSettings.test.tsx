import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installAppBridgeStub, uninstallAppBridgeStub } from '../../../../test-utils/app-bridge-stub';
import { AutomationsSettings } from '../AutomationsSettings';

/** Same jsdom-rect stub the SortableList primitive tests use. */
function stubRowRects(container: HTMLElement, rowHeight = 60): void {
  const rows = Array.from(container.querySelectorAll('[role="listitem"]'));
  rows.forEach((row, index) => {
    vi.spyOn(row as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: index * rowHeight,
      top: index * rowHeight,
      bottom: index * rowHeight + rowHeight,
      left: 0,
      right: 400,
      width: 400,
      height: rowHeight,
      toJSON: () => ({}),
    });
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The rule row's expand/collapse chevron has no accessible name — find it
 * as the first button inside the `automations.rules` list container
 * (chevron always renders before the enable checkbox and delete button,
 * neither of which is a `<button>`... except delete, which comes after). */
function getRuleChevron(container: HTMLElement): HTMLElement {
  const rulesSection = container.querySelector('[data-setting-id="automations.rules"]');
  if (!rulesSection) throw new Error('automations.rules section not found');
  const buttons = within(rulesSection as HTMLElement).getAllByRole('button');
  const chevron = buttons[0];
  if (!chevron) throw new Error('rule chevron button not found');
  return chevron;
}

function baseConfig() {
  return {
    automations: {
      enabled: true,
      log: { maxEntries: 200 },
      approvalMode: 'prompt-user',
      rules: [
        {
          id: 'rule-1',
          name: 'Test rule',
          enabled: true,
          trigger: { source: 'app', event: 'test' },
          conditions: [],
          conditionMode: 'all',
          debounceMs: 0,
          actions: [
            { type: 'notification', title: 'First action title' },
            { type: 'notification', title: 'Second action title' },
            { type: 'notification', title: 'Third action title' },
          ] as Array<Record<string, unknown>>,
        },
      ],
    },
  };
}

afterEach(() => {
  uninstallAppBridgeStub();
  vi.restoreAllMocks();
});

describe('AutomationsSettings action reordering', () => {
  it('preserves each action row\'s own field values after a keyboard reorder (index-key regression guard)', async () => {
    // `TextField` re-syncs its displayed value from `value` via a `useEffect`
    // whenever the field isn't focused (see shared.tsx) — so asserting on a
    // TextField's `.value` after a reorder only proves the reordered *data*
    // landed in the right slot, not that React reused the correct component
    // instance. The instance-identity risk (stale index-keyed rows reusing
    // the wrong child, dragging along whatever *local, non-prop-derived*
    // state that child held) only shows up through state that is NOT synced
    // from props. `JsonField`'s parse-error banner (`useState<string|null>`,
    // set only inside its own `onBlur` handler, never reset from `value`) is
    // exactly that kind of state, so this test drives an error into one
    // action's JSON textarea and confirms the error follows that action
    // across a reorder rather than staying pinned to its old slot index.
    installAppBridgeStub({
      automations: {
        catalog: async () => [],
        log: async () => [],
        onCatalogChanged: () => () => undefined,
        onRun: () => () => undefined,
      },
      modelCatalog: async () => ({ models: [] }),
      profileCatalog: async () => ({ profiles: [], defaultKey: null }),
      conversations: { list: async () => [] },
    });
    const updateConfig = vi.fn(async () => undefined);
    const config = baseConfig();
    config.automations.rules[0]!.actions = [
      { type: 'tool', toolName: 'alpha', input: {} },
      { type: 'tool', toolName: 'beta', input: {} },
    ];

    const { rerender } = render(<AutomationsSettings config={config} updateConfig={updateConfig} />);

    // Expand the rule to render its actions.
    fireEvent.click(getRuleChevron(document.body));
    expect(await screen.findByDisplayValue('alpha')).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'actions' });
    stubRowRects(list);

    // Put row 0 (toolName "alpha") into a parse-error state via its JSON
    // textarea. This error lives only in JsonField's local useState — never
    // written to config, never derived from `value` — so it will NOT follow
    // the data through a prop-driven re-render; it only follows the DOM node
    // React chooses to reuse.
    const jsonFields = within(list).getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');
    fireEvent.change(jsonFields[0]!, { target: { value: '{ not valid json' } });
    fireEvent.blur(jsonFields[0]!);
    // Exact browser/V8 JSON.parse error text; match narrowly because the
    // "Input (JSON)" label text itself would also match a loose /JSON/ regex.
    expect(await screen.findByText(/Expected property name/)).toBeInTheDocument();

    const rowsBefore = within(list).getAllByRole('listitem');
    expect(rowsBefore[0]?.textContent).toMatch(/Expected property name/);
    expect(rowsBefore[1]?.textContent).not.toMatch(/Expected property name/);

    // Reorder: move action #1 ("alpha", currently erroring) down one slot,
    // past action #2 ("beta").
    const handles = within(list).getAllByRole('button', { name: /^Reorder action \d$/ });
    const handleFirst = handles[0]!;
    handleFirst.focus();
    fireEvent.keyDown(handleFirst, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleFirst, { code: 'ArrowDown' });
    fireEvent.keyDown(handleFirst, { code: 'Space' });

    // onChange fired with the reordered actions array — apply it back into
    // config, the same way the real parent (`patchRule` → config round-trip)
    // would, then re-render to read the settled DOM.
    const lastCall = updateConfig.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const [path, nextRules] = lastCall as unknown as [string, unknown];
    expect(path).toBe('automations.rules');
    const nextConfig = { automations: { ...config.automations, rules: nextRules } };
    rerender(<AutomationsSettings config={nextConfig} updateConfig={updateConfig} />);

    const reorderedList = screen.getByRole('list', { name: 'actions' });
    const rowsAfter = within(reorderedList).getAllByRole('listitem');
    // "beta" (no error) is now first; "alpha" (still erroring) is now second.
    // If the row keyed by array index instead of the action's own identity,
    // the error banner would stay attached to slot 0 (now "beta") instead of
    // travelling with "alpha" into slot 1.
    expect(rowsAfter[0]?.textContent).not.toMatch(/Expected property name/);
    expect(rowsAfter[1]?.textContent).toMatch(/Expected property name/);
  });

  it('keeps the remove guard: a rule with only one action cannot remove it', async () => {
    installAppBridgeStub({
      automations: {
        catalog: async () => [],
        log: async () => [],
        onCatalogChanged: () => () => undefined,
        onRun: () => () => undefined,
      },
      modelCatalog: async () => ({ models: [] }),
      profileCatalog: async () => ({ profiles: [], defaultKey: null }),
      conversations: { list: async () => [] },
    });
    const config = baseConfig();
    config.automations.rules[0]!.actions = [{ type: 'notification', title: 'Only action' }];

    render(<AutomationsSettings config={config} updateConfig={vi.fn()} />);
    fireEvent.click(getRuleChevron(document.body));
    await screen.findByDisplayValue('Only action');

    // No per-row remove (trash) button should be rendered when it's the only
    // action. The trash button has no accessible name, so any unnamed button
    // inside the actions list would have to be it — the drag handle itself
    // carries its own accessible name ("Reorder action 1") via getItemLabel,
    // so it does not show up in this query.
    const list = screen.getByRole('list', { name: 'actions' });
    expect(within(list).queryAllByRole('button', { name: '' })).toHaveLength(0);
    expect(within(list).getByRole('button', { name: 'Reorder action 1' })).toBeInTheDocument();
  });
});
