import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfileSettings } from '../ProfileSettings';

/** Same jsdom-rect stub the SortableList primitive tests use — see the
 * comment there for why keyboard-sensor collision math needs it. */
function stubRowRects(container: HTMLElement, rowHeight = 32): void {
  const rows = Array.from(container.querySelectorAll('[role="listitem"]'));
  rows.forEach((row, index) => {
    vi.spyOn(row as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: index * rowHeight,
      top: index * rowHeight,
      bottom: index * rowHeight + rowHeight,
      left: 0,
      right: 200,
      width: 200,
      height: rowHeight,
      toJSON: () => ({}),
    });
  });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const CATALOG = [
  { key: 'model-a', displayName: 'Model A' },
  { key: 'model-b', displayName: 'Model B' },
  { key: 'model-c', displayName: 'Model C' },
];

const CONFIG = {
  profiles: [
    {
      key: 'p1',
      name: 'Profile One',
      primaryModelKey: 'model-a',
      fallbackModelKeys: ['model-b', 'model-c'],
    },
  ],
  models: { catalog: CATALOG },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProfileSettings model chain', () => {
  it('reorders the chain via keyboard and splits primary/fallback correctly on save', async () => {
    const updateConfig = vi.fn(async () => undefined);
    render(<ProfileSettings config={CONFIG} updateConfig={updateConfig} />);

    fireEvent.click(screen.getByTitle('Edit'));

    const list = screen.getByRole('list', { name: 'model chain' });
    stubRowRects(list);

    // Chain starts as [Model A, Model B, Model C]. Move Model A down one slot
    // so Model B becomes primary: [Model B, Model A, Model C].
    const handleA = screen.getByRole('button', { name: 'Reorder Model A' });
    handleA.focus();
    fireEvent.keyDown(handleA, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleA, { code: 'ArrowDown' });
    fireEvent.keyDown(handleA, { code: 'Space' });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateConfig).toHaveBeenCalledWith('profiles', [
      expect.objectContaining({
        key: 'p1',
        primaryModelKey: 'model-b',
        fallbackModelKeys: ['model-a', 'model-c'],
      }),
    ]);
  });

  it('moves the "Primary" pill onto whichever row is now first after reorder', async () => {
    const updateConfig = vi.fn(async () => undefined);
    render(<ProfileSettings config={CONFIG} updateConfig={updateConfig} />);
    fireEvent.click(screen.getByTitle('Edit'));

    const list = screen.getByRole('list', { name: 'model chain' });
    stubRowRects(list);

    const rowsBefore = within(list).getAllByRole('listitem');
    expect(within(rowsBefore[0]!).getByText('Primary')).toBeInTheDocument();
    expect(within(rowsBefore[0]!).getByText('Model A')).toBeInTheDocument();

    const handleA = screen.getByRole('button', { name: 'Reorder Model A' });
    handleA.focus();
    fireEvent.keyDown(handleA, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleA, { code: 'ArrowDown' });
    fireEvent.keyDown(handleA, { code: 'Space' });

    const rowsAfter = within(list).getAllByRole('listitem');
    expect(within(rowsAfter[0]!).getByText('Primary')).toBeInTheDocument();
    expect(within(rowsAfter[0]!).getByText('Model B')).toBeInTheDocument();
    // The old first row no longer carries the pill.
    expect(within(rowsAfter[1]!).queryByText('Primary')).not.toBeInTheDocument();
  });

  it('disables removing the last remaining model in the chain', () => {
    const configWithSingleModelProfile = {
      profiles: [{ key: 'p1', name: 'Profile One', primaryModelKey: 'model-a', fallbackModelKeys: [] }],
      models: { catalog: CATALOG },
    };
    render(<ProfileSettings config={configWithSingleModelProfile} updateConfig={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Edit'));

    const removeButton = screen.getByRole('button', { name: 'Remove Model A from chain' });
    expect(removeButton).toBeDisabled();

    fireEvent.click(removeButton);
    // Still exactly one row — the click was a no-op.
    expect(within(screen.getByRole('list', { name: 'model chain' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('allows removing down to one model, then disables further removal', () => {
    const updateConfig = vi.fn(async () => undefined);
    render(<ProfileSettings config={CONFIG} updateConfig={updateConfig} />);
    fireEvent.click(screen.getByTitle('Edit'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Model C from chain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Model B from chain' }));

    const list = screen.getByRole('list', { name: 'model chain' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove Model A from chain' })).toBeDisabled();
  });
});
