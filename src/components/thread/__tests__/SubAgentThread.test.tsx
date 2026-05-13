/**
 * Tests for SubAgentThread component
 * 
 * Covers: Escape key handler, back button functionality, layout stability
 * Related to: KAI-SUBAGENT-002 bug fix
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SubAgentThread } from '../SubAgentThread';

// Mock the RuntimeProvider
vi.mock('@/providers/RuntimeProvider', () => ({
  useSubAgents: () => ({
    threads: new Map([
      [
        'test-123',
        {
          task: 'Test sub-agent task',
          status: 'idle',
          messages: [],
          depth: 0,
        },
      ],
    ]),
    sendMessage: vi.fn(),
    stop: vi.fn(),
  }),
}));

describe('SubAgentThread - KAI-SUBAGENT-002 Fix', () => {
  const mockOnBack = vi.fn();

  beforeEach(() => {
    mockOnBack.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Escape Key Handler (Critical Fix)', () => {
    it('should call onBack when Escape key is pressed', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      // Press Escape
      fireEvent.keyDown(window, { key: 'Escape' });

      expect(mockOnBack).toHaveBeenCalledTimes(1);
    });

    it('should not call onBack when other keys are pressed', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      // Press other keys
      fireEvent.keyDown(window, { key: 'Enter' });
      fireEvent.keyDown(window, { key: 'Space' });
      fireEvent.keyDown(window, { key: 'a' });

      expect(mockOnBack).not.toHaveBeenCalled();
    });

    it('should clean up event listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      const { unmount } = render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'keydown',
        expect.any(Function)
      );

      removeEventListenerSpy.mockRestore();
    });

    it('should handle multiple rapid Escape presses without errors', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      // Rapid Escape presses
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape' });
      fireEvent.keyDown(window, { key: 'Escape' });

      // Should be called 3 times
      expect(mockOnBack).toHaveBeenCalledTimes(3);
    });
  });

  describe('Back Button Visibility and Clickability', () => {
    it('should render back button with proper accessibility attributes', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const backButton = screen.getByRole('button', {
        name: /back to parent thread/i,
      });

      expect(backButton).toBeInTheDocument();
      expect(backButton).toHaveAttribute('type', 'button');
      expect(backButton).toHaveAttribute('title');
    });

    it('should have proper z-index classes to prevent collision', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const backButton = screen.getByRole('button', {
        name: /back to parent thread/i,
      });

      // Check CSS classes that prevent collision
      expect(backButton.className).toContain('z-50');
      expect(backButton.className).toContain('relative');
    });

    it('should have pointer-events auto style to guarantee clickability', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const backButton = screen.getByRole('button', {
        name: /back to parent thread/i,
      });

      expect(backButton).toHaveStyle({ pointerEvents: 'auto' });
    });

    it('should have focus ring classes for keyboard navigation accessibility', () => {
      render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const backButton = screen.getByRole('button', {
        name: /back to parent thread/i,
      });

      expect(backButton.className).toContain('focus:ring-2');
      expect(backButton.className).toContain('focus:ring-primary');
    });
  });

  describe('Layout and Container (Overflow Prevention)', () => {
    it('should render main container with overflow protection', () => {
      const { container } = render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const mainDiv = container.querySelector('.flex.h-full.flex-col');

      expect(mainDiv).toBeInTheDocument();
      expect(mainDiv?.className).toContain('min-h-0');
      expect(mainDiv?.className).toContain('overflow-hidden');
    });

    it('should render sticky header with proper z-index layering', () => {
      const { container } = render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const header = container.querySelector('.sticky.top-0');

      expect(header).toBeInTheDocument();
      expect(header?.className).toContain('z-40');
      expect(header?.className).toContain('bg-background');
    });

    it('should render messages container with min-h-0 for proper flex behavior', () => {
      const { container } = render(
        <SubAgentThread subAgentConversationId="test-123" onBack={mockOnBack} />
      );

      const messagesDiv = container.querySelector('.flex-1.overflow-y-auto');

      expect(messagesDiv).toBeInTheDocument();
      expect(messagesDiv?.className).toContain('min-h-0');
    });
  });
});
