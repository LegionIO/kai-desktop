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
          ],
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

    const { rerender } = render(<AutomationsSettings config={config} updateConfig={updateConfig} />);

    // Expand the rule to render its actions.
    fireEvent.click(getRuleChevron(document.body));
    expect(await screen.findByDisplayValue('First action title')).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'actions' });
    stubRowRects(list);

    // Reorder: move action #1 ("First action title") down one slot, past
    // action #2. If the list were still keyed by array index (the bug this
    // change fixes), React would reuse the ActionEditor DOM node in slot 0
    // for whatever action now occupies index 0 in the underlying array —
    // any locally-buffered/uncommitted field state would appear attached to
    // the wrong action. Reading the value straight out of the rendered
    // inputs below verifies the fields travel WITH their action, not with
    // their slot.
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
    const titleInputs = within(reorderedList)
      .getAllByRole('textbox')
      // Each notification action renders two text fields, Title then Body,
      // in that order — Title is always the first of each pair.
      .filter((_, i) => i % 2 === 0);
    // Second action should now be first, First action second, Third unchanged.
    expect(titleInputs.map((el) => (el as HTMLInputElement).value)).toEqual([
      'Second action title',
      'First action title',
      'Third action title',
    ]);
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
