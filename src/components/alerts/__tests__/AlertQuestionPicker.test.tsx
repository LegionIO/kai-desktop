/**
 * Component test — AlertQuestionPicker multi-select answer integrity.
 *
 * Regression guard: multi-select selections were previously stored as a
 * comma-joined string and split on ", ", which corrupted option labels
 * containing ", " and collided with the "__other__" sentinel. Selections are
 * now kept as a Set + separate Other-text state and only joined at submit.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AlertQuestionPicker } from '../AlertQuestionPicker';
import type { AlertQuestion } from '@/lib/ipc-client';

describe('AlertQuestionPicker multi-select', () => {
  const multiQ: AlertQuestion = {
    question: 'Which apply?',
    header: 'Apply',
    multiSelect: true,
    options: [{ label: 'Red, green' }, { label: 'Blue' }, { label: '__other__ lookalike' }],
  };

  it('preserves an option label containing ", " and joins multiple selections', () => {
    const onSubmit = vi.fn();
    render(<AlertQuestionPicker questions={[multiQ]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('Red, green'));
    fireEvent.click(screen.getByText('Blue'));
    fireEvent.click(screen.getByText('Submit answer'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const answer = onSubmit.mock.calls[0][0] as Record<string, string>;
    // The comma-containing label survives intact; both picks present.
    expect(answer['Which apply?']).toBe('Red, green, Blue');
  });

  it('toggling an option off removes only that option', () => {
    const onSubmit = vi.fn();
    render(<AlertQuestionPicker questions={[multiQ]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('Red, green'));
    fireEvent.click(screen.getByText('Blue'));
    fireEvent.click(screen.getByText('Blue')); // toggle Blue off
    fireEvent.click(screen.getByText('Submit answer'));

    const answer = onSubmit.mock.calls[0][0] as Record<string, string>;
    expect(answer['Which apply?']).toBe('Red, green');
  });

  it('merges the Other free-text alongside picked options', () => {
    const onSubmit = vi.fn();
    render(<AlertQuestionPicker questions={[multiQ]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('Blue'));
    fireEvent.change(screen.getByPlaceholderText('Other…'), { target: { value: 'custom answer' } });
    fireEvent.click(screen.getByText('Submit answer'));

    const answer = onSubmit.mock.calls[0][0] as Record<string, string>;
    expect(answer['Which apply?']).toBe('Blue, custom answer');
  });

  it('an option label that looks like the Other sentinel is treated as a normal option', () => {
    const onSubmit = vi.fn();
    render(<AlertQuestionPicker questions={[multiQ]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText('__other__ lookalike'));
    fireEvent.click(screen.getByText('Submit answer'));

    const answer = onSubmit.mock.calls[0][0] as Record<string, string>;
    expect(answer['Which apply?']).toBe('__other__ lookalike');
  });
});
