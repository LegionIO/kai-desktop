import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SortableList } from '../SortableList';

/**
 * dnd-kit measures every row's `getBoundingClientRect()` to know which row
 * is "above"/"below" the active one when the keyboard sensor moves it.
 * jsdom returns an all-zero rect for everything, so without a stub every
 * row collapses to the same rect and the collision math can't tell them
 * apart. Stack rows vertically at a fixed height so keyboard ArrowDown/Up
 * behaves the way it would in a real layout.
 */
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

/**
 * `KeyboardSensor.attach()` adds its document-level keydown listener inside
 * a `setTimeout(0)` (see @dnd-kit/core), so the pick-up keydown (handled
 * synchronously by the activator's own `onKeyDown`) and the subsequent
 * move/drop keydowns (handled by that deferred document listener) can't
 * all fire in the same synchronous batch. Yield a real macrotask between
 * them so the sensor has attached before the next key event.
 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fixture: an ordered list of ids the test can drive via a controlled harness. */
function Fixture({
  initialItems,
  onReorderSpy,
}: {
  initialItems: string[];
  onReorderSpy: (next: string[]) => void;
}) {
  const [items, setItems] = useState(initialItems);
  return (
    <SortableList
      items={items}
      onReorder={(next) => {
        setItems(next);
        onReorderSpy(next);
      }}
      ariaLabel="fixture list"
      getItemLabel={(id) => id}
      renderItem={(id) => <span>{id}</span>}
    />
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SortableList', () => {
  it('reorders via the keyboard: pick up, move down, drop', async () => {
    const onReorder = vi.fn();
    const { container } = render(<Fixture initialItems={['a', 'b', 'c']} onReorderSpy={onReorder} />);
    stubRowRects(container);

    const handleA = screen.getByRole('button', { name: 'Reorder a' });
    handleA.focus();

    // Pick up (Space), move down one slot (ArrowDown), drop (Space).
    fireEvent.keyDown(handleA, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleA, { code: 'ArrowDown' });
    fireEvent.keyDown(handleA, { code: 'Space' });

    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);
  });

  it('cancels a keyboard drag with Escape, leaving order unchanged', async () => {
    const onReorder = vi.fn();
    const { container } = render(<Fixture initialItems={['a', 'b', 'c']} onReorderSpy={onReorder} />);
    stubRowRects(container);

    const handleA = screen.getByRole('button', { name: 'Reorder a' });
    handleA.focus();

    fireEvent.keyDown(handleA, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleA, { code: 'ArrowDown' });
    fireEvent.keyDown(handleA, { code: 'Escape' });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores Space/Enter on a target other than the handle itself', async () => {
    // Regression guard for the drag-handle-only wiring: activation must require
    // `event.target === activatorNode`, not just "anywhere inside the row".
    const onReorder = vi.fn();
    render(
      <SortableList
        items={['a', 'b']}
        onReorder={onReorder}
        ariaLabel="fixture list"
        renderItem={(id) => <input aria-label={`field-${id}`} defaultValue={id} />}
      />,
    );

    const field = screen.getByLabelText('field-a');
    field.focus();
    fireEvent.keyDown(field, { code: 'Space' });
    await tick();
    fireEvent.keyDown(field, { code: 'ArrowDown' });
    fireEvent.keyDown(field, { code: 'Space' });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('labels each handle with a default when getItemLabel is omitted', () => {
    render(
      <SortableList items={['x', 'y']} onReorder={vi.fn()} ariaLabel="fixture list" renderItem={(id) => <span>{id}</span>} />,
    );
    expect(screen.getByRole('button', { name: 'Reorder item 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reorder item 2' })).toBeInTheDocument();
  });

  it('does not call onReorder when dropped back on the same slot', async () => {
    const onReorder = vi.fn();
    const { container } = render(<Fixture initialItems={['a', 'b', 'c']} onReorderSpy={onReorder} />);
    stubRowRects(container);

    const handleA = screen.getByRole('button', { name: 'Reorder a' });
    handleA.focus();
    fireEvent.keyDown(handleA, { code: 'Space' });
    await tick();
    fireEvent.keyDown(handleA, { code: 'Space' });

    expect(onReorder).not.toHaveBeenCalled();
  });
});
