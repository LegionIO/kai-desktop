// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RuntimePicker } from '../RuntimePicker';

describe('RuntimePicker autonomy warning', () => {
  it('shows the autonomy warning when pi (no per-action approval) is selected', () => {
    render(<RuntimePicker value="pi" onChange={vi.fn()} />);
    expect(screen.getByText(/without per-action approval/i)).toBeInTheDocument();
  });

  it('does not show the autonomy warning for a runtime that gates per action (claude-code)', () => {
    render(<RuntimePicker value="claude-code" onChange={vi.fn()} />);
    expect(screen.queryByText(/without per-action approval/i)).toBeNull();
  });
});
