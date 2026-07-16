/**
 * Component test — TextArea local-buffer behavior.
 *
 * Regression guard for the automations "prompt" cursor-reset bug: driving a raw
 * `value={…}` textarea while the parent round-trips config through async IPC
 * (updateConfig → await set → setConfig replaces the whole object) reset the caret
 * on every keystroke. TextArea keeps a local value while focused and only syncs
 * from the prop when NOT focused, so typing is never clobbered.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TextArea } from '../shared';

describe('TextArea (buffered, focus-guarded)', () => {
  it('shows the typed value immediately without waiting on onChange', () => {
    const onChange = vi.fn();
    render(<TextArea value="" onChange={onChange} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: 'hello' } });
    expect(ta.value).toBe('hello'); // local state, not gated on onChange
  });

  it('does NOT clobber the local value from a prop change WHILE focused', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TextArea value="a" onChange={onChange} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: 'abc' } });
    // Parent's async config round-trip lands a stale value while the user types:
    rerender(<TextArea value="a" onChange={onChange} />);
    expect(ta.value).toBe('abc'); // local edit preserved (caret would survive)
  });

  it('syncs from the prop when NOT focused (external config reload)', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TextArea value="a" onChange={onChange} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    // Not focused → an external change should reflect.
    rerender(<TextArea value="external" onChange={onChange} />);
    expect(ta.value).toBe('external');
  });

  it('flushes onChange on blur', () => {
    const onChange = vi.fn();
    render(<TextArea value="" onChange={onChange} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: 'draft' } });
    act(() => {
      fireEvent.blur(ta);
    });
    expect(onChange).toHaveBeenCalledWith('draft');
  });
});
