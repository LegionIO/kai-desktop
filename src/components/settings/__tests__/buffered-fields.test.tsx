import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasswordField, TextField } from '../shared';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * `TextField`/`PasswordField` exist so a keystroke does NOT become an IPC
 * round-trip + whole-config rewrite (and so the async round-trip can't reset the
 * caret mid-word). These cover the buffering contract that ~34 settings fields
 * now depend on.
 */
describe('TextField buffering', () => {
  it('does not call onChange while typing, then flushes once on blur', () => {
    const onChange = vi.fn();
    render(<TextField label="Region" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Region');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'e' } });
    fireEvent.change(input, { target: { value: 'ea' } });
    fireEvent.change(input, { target: { value: 'eastus' } });
    // The whole point: three keystrokes, zero writes so far.
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('eastus');
  });

  it('debounces to a single write when the user stops typing without blurring', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<TextField label="Model" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Model');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'sora' } });
    fireEvent.change(input, { target: { value: 'sora-2' } });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('sora-2');
  });

  it('keeps the caret-safe local value when an async parent re-render lands mid-typing', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TextField label="Endpoint" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Endpoint') as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'https://mine' } });
    // A config reload (or any parent re-render with a stale value) must not
    // clobber what the focused user is typing — that was the caret-jump bug.
    rerender(<TextField label="Endpoint" value="" onChange={onChange} />);
    expect(input.value).toBe('https://mine');
  });

  it('syncs from the parent when NOT focused', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TextField label="Endpoint" value="a" onChange={onChange} />);
    const input = screen.getByLabelText('Endpoint') as HTMLInputElement;
    expect(input.value).toBe('a');

    rerender(<TextField label="Endpoint" value="b" onChange={onChange} />);
    expect(input.value).toBe('b');
  });

  it('flushes a pending draft when unmounted mid-debounce instead of dropping it', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const { unmount } = render(<TextField label="Model" value="" onChange={onChange} />);
    const input = screen.getByLabelText('Model');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'gpt-image-2' } });
    // Switching provider/tab unmounts the field before the 600ms debounce; the
    // typed value must still be committed.
    unmount();
    expect(onChange).toHaveBeenCalledWith('gpt-image-2');
  });

  it('emits undefined rather than empty string when emptyAsUndefined is set', () => {
    const onChange = vi.fn();
    render(<TextField label="Endpoint" value="https://old" onChange={onChange} emptyAsUndefined />);
    const input = screen.getByLabelText('Endpoint');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    // An optional key cleared to '' must become "unset", not an empty override.
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('does not write when the value is unchanged', () => {
    const onChange = vi.fn();
    render(<TextField label="Region" value="eastus" onChange={onChange} />);
    const input = screen.getByLabelText('Region');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PasswordField buffering', () => {
  it('buffers an API key instead of writing every keystroke', () => {
    const onChange = vi.fn();
    render(<PasswordField label="API Key" value="" onChange={onChange} />);
    const input = screen.getByLabelText('API Key');

    fireEvent.focus(input);
    for (const v of ['s', 'sk', 'sk-', 'sk-abc']) {
      fireEvent.change(input, { target: { value: v } });
    }
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('sk-abc');
  });

  it('masks by default and reveals on toggle', async () => {
    render(<PasswordField label="API Key" value="sk-secret" onChange={vi.fn()} />);
    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show API Key' }));
    await waitFor(() => expect((screen.getByLabelText('API Key') as HTMLInputElement).type).toBe('text'));
  });
});
