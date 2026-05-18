// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { IncompleteTaskBanner } from '../IncompleteTaskBanner';

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('IncompleteTaskBanner', () => {
  const mockOnContinue = vi.fn();
  const mockOnAdjustSettings = vi.fn();
  const mockOnDismiss = vi.fn();
  
  const defaultProps = {
    conversationId: 'test-conversation-123',
    currentStep: 25,
    maxSteps: 25,
    onContinue: mockOnContinue,
    onAdjustSettings: mockOnAdjustSettings,
    onDismiss: mockOnDismiss,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all content correctly', () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    expect(screen.getByText('Task incomplete - step limit reached')).toBeInTheDocument();
    expect(screen.getByText(/I reached the maximum number of steps/)).toBeInTheDocument();
    expect(screen.getByText(/\(25\/25\)/)).toBeInTheDocument();
    
    expect(screen.getByRole('button', { name: /Continue Task/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Adjust Settings/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/i })).toBeInTheDocument();
  });

  it('calls onContinue when Continue button clicked', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const continueButton = screen.getByRole('button', { name: /Continue Task/i });
    await userEvent.click(continueButton);
    
    expect(mockOnContinue).toHaveBeenCalledTimes(1);
  });

  it('calls onAdjustSettings when Adjust Settings button clicked', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const adjustButton = screen.getByRole('button', { name: /Adjust Settings/i });
    await userEvent.click(adjustButton);
    
    expect(mockOnAdjustSettings).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when Dismiss button clicked', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const dismissButton = screen.getByRole('button', { name: /Dismiss/i });
    await userEvent.click(dismissButton);
    
    expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  });

  it('handles Cmd+Enter keyboard shortcut', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    
    await waitFor(() => {
      expect(mockOnContinue).toHaveBeenCalledTimes(1);
    });
  });

  it('handles Ctrl+Enter keyboard shortcut', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    
    await waitFor(() => {
      expect(mockOnContinue).toHaveBeenCalledTimes(1);
    });
  });

  it('does not trigger on Enter without modifier keys', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    fireEvent.keyDown(window, { key: 'Enter' });
    
    expect(mockOnContinue).not.toHaveBeenCalled();
  });

  it('cleans up keyboard event listener on unmount', () => {
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    
    const { unmount } = renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    unmount();
    
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function));
  });

  it('has proper accessibility attributes', () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const banner = screen.getByRole('alert');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });

  it('logs console info when Continue clicked', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const continueButton = screen.getByRole('button', { name: /Continue Task/i });
    await userEvent.click(continueButton);
    
    expect(consoleSpy).toHaveBeenCalledWith(
      '[IncompleteTaskBanner] Continue clicked for conversation test-conversation-123'
    );
    
    consoleSpy.mockRestore();
  });

  it('applies custom className', () => {
    const { container } = renderWithProviders(
      <IncompleteTaskBanner {...defaultProps} className="custom-class" />
    );
    
    expect(container.firstChild).toHaveClass('custom-class');
  });

  it('displays correct step counts', () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} currentStep={30} maxSteps={50} />);
    
    expect(screen.getByText(/\(30\/50\)/)).toBeInTheDocument();
  });

  it('prevents default behavior on keyboard shortcut', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const event = new KeyboardEvent('keydown', { 
      key: 'Enter', 
      metaKey: true,
      bubbles: true,
      cancelable: true 
    });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    
    fireEvent(window, event);
    
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it('has hover states on buttons', async () => {
    renderWithProviders(<IncompleteTaskBanner {...defaultProps} />);
    
    const continueButton = screen.getByRole('button', { name: /Continue Task/i });
    expect(continueButton).toHaveClass('hover:bg-amber-700');
    
    const adjustButton = screen.getByRole('button', { name: /Adjust Settings/i });
    expect(adjustButton).toHaveClass('hover:bg-amber-100');
  });
});
