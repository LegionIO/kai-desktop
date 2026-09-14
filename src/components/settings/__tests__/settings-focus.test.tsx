import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  CollapsibleSection,
  ClampedNumberField,
  SettingsFocusContext,
  focusRequestTargets,
  type SettingsFocusRequest,
} from '../shared';

describe('focusRequestTargets', () => {
  it('matches the anchor id directly', () => {
    expect(focusRequestTargets({ anchorId: 'a', nonce: 1 }, 'a')).toBe(true);
  });

  it('matches via the declared always-mounted ancestor', () => {
    // search-index.ts uses fallbackId to name the collapsed section that OWNS the target.
    expect(focusRequestTargets({ anchorId: 'compaction.media', fallbackId: 'mastra.advanced', nonce: 1 }, 'mastra.advanced')).toBe(
      true,
    );
  });

  it('does not match unrelated sections', () => {
    expect(focusRequestTargets({ anchorId: 'a', fallbackId: 'b', nonce: 1 }, 'other')).toBe(false);
  });

  it('is false with no request or no id', () => {
    expect(focusRequestTargets(null, 'a')).toBe(false);
    expect(focusRequestTargets({ anchorId: 'a', nonce: 1 }, undefined)).toBe(false);
  });
});

describe('CollapsibleSection search auto-expand', () => {
  const Inner = () => <div data-setting-id="compaction.media">media controls</div>;

  function renderWith(focus: SettingsFocusRequest | null) {
    return render(
      <SettingsFocusContext.Provider value={focus}>
        <CollapsibleSection id="mastra.advanced" title="Advanced Runtime Config">
          <Inner />
        </CollapsibleSection>
      </SettingsFocusContext.Provider>,
    );
  }

  it('stays collapsed with no focus request, hiding its children', () => {
    renderWith(null);
    expect(screen.queryByText('media controls')).toBeNull();
  });

  it('opens when the focus request targets the section itself', () => {
    renderWith({ anchorId: 'mastra.advanced', nonce: 1 });
    expect(screen.getByText('media controls')).toBeTruthy();
  });

  it('opens when a search result INSIDE it declares it as the fallback ancestor', () => {
    // The regression this fixes: the panel used to highlight the closed fieldset and stop,
    // so the real target was never in the DOM.
    renderWith({ anchorId: 'compaction.media', fallbackId: 'mastra.advanced', nonce: 1 });
    expect(screen.getByText('media controls')).toBeTruthy();
  });

  it('ignores a focus request aimed elsewhere', () => {
    renderWith({ anchorId: 'tools.shell.enabled', fallbackId: 'tools.shell.enabled', nonce: 1 });
    expect(screen.queryByText('media controls')).toBeNull();
  });

  it('re-opens when the same setting is searched again after a manual collapse', () => {
    const { rerender } = render(
      <SettingsFocusContext.Provider value={{ anchorId: 'mastra.advanced', nonce: 1 }}>
        <CollapsibleSection id="mastra.advanced" title="Advanced Runtime Config">
          <Inner />
        </CollapsibleSection>
      </SettingsFocusContext.Provider>,
    );
    expect(screen.getByText('media controls')).toBeTruthy();

    // Same ids, new nonce — the effect must re-fire (this is why nonce exists).
    rerender(
      <SettingsFocusContext.Provider value={{ anchorId: 'mastra.advanced', nonce: 2 }}>
        <CollapsibleSection id="mastra.advanced" title="Advanced Runtime Config">
          <Inner />
        </CollapsibleSection>
      </SettingsFocusContext.Provider>,
    );
    expect(screen.getByText('media controls')).toBeTruthy();
  });

  it('never auto-closes a section the user opened by hand', () => {
    const { rerender } = renderWith({ anchorId: 'mastra.advanced', nonce: 1 });
    expect(screen.getByText('media controls')).toBeTruthy();
    // A later, unrelated navigation must not collapse it.
    rerender(
      <SettingsFocusContext.Provider value={{ anchorId: 'something.else', nonce: 2 }}>
        <CollapsibleSection id="mastra.advanced" title="Advanced Runtime Config">
          <Inner />
        </CollapsibleSection>
      </SettingsFocusContext.Provider>,
    );
    expect(screen.getByText('media controls')).toBeTruthy();
  });
});

describe('ClampedNumberField', () => {
  function Harness({ min, max, initial }: { min: number; max: number; initial: number }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <ClampedNumberField label="Floor (MB)" value={value} min={min} max={max} onCommit={setValue} />
        <span data-testid="committed">{value}</span>
      </>
    );
  }

  const input = () => screen.getByRole('spinbutton') as HTMLInputElement;

  it('lets a multi-digit value be typed without clamping mid-entry', () => {
    // The bug: clamping in onChange turned "4000" into 16384, because the first
    // keystroke "4" was clamped up to the 256 minimum and later digits appended.
    render(<Harness min={256} max={16384} initial={3000} />);
    fireEvent.focus(input());
    for (const partial of ['', '4', '40', '400', '4000']) {
      fireEvent.change(input(), { target: { value: partial } });
    }
    // Nothing committed yet, and the draft is exactly what was typed.
    expect(input().value).toBe('4000');
    expect(screen.getByTestId('committed').textContent).toBe('3000');

    fireEvent.blur(input());
    expect(screen.getByTestId('committed').textContent).toBe('4000');
  });

  it('clamps to the range on commit', () => {
    render(<Harness min={50} max={99} initial={85} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '5000' } });
    fireEvent.blur(input());
    expect(screen.getByTestId('committed').textContent).toBe('99');
  });

  it('reverts to the last good value when cleared, instead of writing 0', () => {
    // A blank field previously produced Number('') === 0, which schema .positive()
    // rejects — and ConfigProvider swallows the rejection, so it failed silently.
    render(<Harness min={10} max={600} initial={60} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '' } });
    fireEvent.blur(input());
    expect(screen.getByTestId('committed').textContent).toBe('60');
    expect(input().value).toBe('60');
  });

  it('commits on Enter as well as blur', () => {
    render(<Harness min={256} max={16384} initial={3000} />);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: '512' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(screen.getByTestId('committed').textContent).toBe('512');
  });

  it('does not call onCommit when the clamped value is unchanged', () => {
    const onCommit = vi.fn();
    render(<ClampedNumberField label="x" value={100} min={1} max={1000} onCommit={onCommit} />);
    fireEvent.focus(input());
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
