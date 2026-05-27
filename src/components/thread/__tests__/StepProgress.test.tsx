// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepProgress } from '../StepProgress';

describe('StepProgress', () => {
  it('renders compact display when below 80% threshold', () => {
    const { container } = render(<StepProgress currentStep={10} maxSteps={25} />);
    
    expect(screen.getByText(/Steps: 10\/25/)).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).toHaveClass('text-green-500');
  });

  it('shows progress bar at 80% threshold', () => {
    const { container } = render(<StepProgress currentStep={20} maxSteps={25} />);
    
    expect(screen.getByText(/Steps: 20\/25/)).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    // Progress bar is a styled div — query by its fill class
    const progressBar = container.querySelector('.bg-blue-500, .bg-amber-500');
    expect(progressBar).toBeInTheDocument();
  });

  it('shows amber warning at 90%', () => {
    render(<StepProgress currentStep={23} maxSteps={25} />);
    
    expect(screen.getByText(/Steps: 23\/25/)).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
  });

  it('shows alert styling when limit reached', () => {
    const { container } = render(<StepProgress currentStep={25} maxSteps={25} hitLimit={true} />);
    
    expect(screen.getByText(/Step limit reached \(25\/25\)/)).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).toHaveClass('text-amber-500');
  });

  it('applies custom className', () => {
    const { container } = render(
      <StepProgress currentStep={10} maxSteps={25} className="custom-class" />
    );
    
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('calculates percentage correctly', () => {
    render(<StepProgress currentStep={15} maxSteps={30} />);
    
    // 15/30 = 50%, should not show progress bar (< 80%)
    expect(screen.queryByText('50%')).not.toBeInTheDocument();
  });

  it('shows progress bar at exactly 80%', () => {
    render(<StepProgress currentStep={20} maxSteps={25} />);
    
    expect(screen.getByText('80%')).toBeInTheDocument();
  });

  it('caps percentage at 100%', () => {
    render(<StepProgress currentStep={30} maxSteps={25} hitLimit={true} />);
    
    // Should show limit reached, not > 100%
    expect(screen.getByText(/Step limit reached/)).toBeInTheDocument();
  });
});
