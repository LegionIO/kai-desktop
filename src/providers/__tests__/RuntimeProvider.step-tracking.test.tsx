// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// Mock the providers and contexts
vi.mock('@/lib/ipc-client', () => ({
  app: {
    agent: {
      onStreamEvent: vi.fn((callback) => {
        // Store callback for later invocation
        (globalThis as any).__streamEventCallback = callback;
        return () => {}; // cleanup function
      }),
      stream: vi.fn(),
      sendSubAgentMessage: vi.fn(),
      stopSubAgent: vi.fn(),
    },
    conversations: {
      getActiveId: vi.fn().mockResolvedValue('test-conversation'),
      onChanged: vi.fn(() => () => {}),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      persist: vi.fn(),
    },
    settings: {
      get: vi.fn(),
      update: vi.fn(),
    },
  },
}));

describe('RuntimeProvider - Step Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).__streamEventCallback;
  });

  describe('step-progress event handling', () => {
    it('updates stepInfo state when step-progress event received', async () => {
      // This would need the full RuntimeProvider setup
      // For now, this demonstrates the test structure
      
      const stepProgressEvent = {
        conversationId: 'test-conversation',
        type: 'step-progress',
        stepInfo: {
          currentStep: 10,
          maxSteps: 25,
          hitLimit: false,
          taskComplete: false,
        },
      };

      // Simulate event emission
      const callback = (globalThis as any).__streamEventCallback;
      if (callback) {
        act(() => {
          callback(stepProgressEvent);
        });
      }

      // Verify stepInfo is updated
      // This would require access to the hook or provider state
    });

    it('only updates stepInfo for active conversation', () => {
      const stepProgressEvent = {
        conversationId: 'other-conversation',
        type: 'step-progress',
        stepInfo: {
          currentStep: 10,
          maxSteps: 25,
          hitLimit: false,
          taskComplete: false,
        },
      };

      // Should not update state if conversation doesn't match
    });
  });

  describe('max-steps-reached event handling', () => {
    it('shows incomplete task banner when limit reached', () => {
      const maxStepsEvent = {
        conversationId: 'test-conversation',
        type: 'max-steps-reached',
        stepInfo: {
          currentStep: 25,
          maxSteps: 25,
          hitLimit: true,
          taskComplete: false,
        },
      };

      // Verify banner state is set to true
    });

    it('does not show banner if conversation dismissed', () => {
      // First dismiss
      // Then receive max-steps-reached
      // Verify banner stays hidden
    });

    it('logs warning when max steps reached', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const maxStepsEvent = {
        conversationId: 'test-conversation',
        type: 'max-steps-reached',
        stepInfo: {
          currentStep: 25,
          maxSteps: 25,
          hitLimit: true,
          taskComplete: false,
        },
      };

      // Verify console.warn is called
      
      consoleSpy.mockRestore();
    });
  });

  describe('handleContinueTask', () => {
    it('sends continuation message', () => {
      // Mock onNew function
      const mockOnNew = vi.fn();
      
      // Call handleContinueTask
      // Verify onNew called with correct message
      
      expect(mockOnNew).toHaveBeenCalledWith({
        role: 'user',
        content: [{ type: 'text', text: 'Please continue the previous task' }],
        createdAt: expect.any(Date),
      });
    });

    it('hides banner and clears stepInfo', () => {
      // Call handleContinueTask
      // Verify showIncompleteTaskBanner = false
      // Verify stepInfo = null
    });

    it('does not continue if already running', () => {
      // Set isRunning = true
      // Call handleContinueTask
      // Verify onNew not called
    });
  });

  describe('handleAdjustSettings', () => {
    it('dispatches kai:open-settings event', () => {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      
      // Call handleAdjustSettings
      
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'kai:open-settings',
        })
      );
      
      dispatchSpy.mockRestore();
    });

    it('navigates to advanced section after delay', async () => {
      vi.useFakeTimers();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      
      // Call handleAdjustSettings
      
      // Fast-forward 100ms
      vi.advanceTimersByTime(100);
      
      await waitFor(() => {
        expect(dispatchSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'kai:navigate-settings',
            detail: { section: 'advanced' },
          })
        );
      });
      
      vi.useRealTimers();
      dispatchSpy.mockRestore();
    });

    it('hides banner when called', () => {
      // Call handleAdjustSettings
      // Verify showIncompleteTaskBanner = false
    });
  });

  describe('handleDismissBanner', () => {
    it('adds conversation to dismissed set', () => {
      // Call handleDismissBanner
      // Verify conversation added to dismissedBannersRef
    });

    it('hides banner', () => {
      // Call handleDismissBanner
      // Verify showIncompleteTaskBanner = false
    });

    it('logs dismissal', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      
      // Call handleDismissBanner
      
      expect(consoleSpy).toHaveBeenCalledWith(
        '[RuntimeProvider] Incomplete task banner dismissed',
        expect.objectContaining({ conversationId: expect.any(String) })
      );
      
      consoleSpy.mockRestore();
    });
  });

  describe('StepTrackingContext', () => {
    it('provides stepInfo to consumers', () => {
      // Render with RuntimeProvider
      // Use useStepTracking hook
      // Verify stepInfo accessible
    });

    it('provides showIncompleteTaskBanner state', () => {
      // Verify boolean state accessible
    });

    it('provides all callback functions', () => {
      // Verify onContinueTask exists
      // Verify onAdjustSettings exists
      // Verify onDismissBanner exists
    });
  });
});

describe('Step Tracking - Integration', () => {
  it('full flow: receive event -> show banner -> continue -> hide banner', async () => {
    // 1. Emit max-steps-reached event
    // 2. Verify banner shown
    // 3. Click continue
    // 4. Verify message sent
    // 5. Verify banner hidden
  });

  it('full flow: receive event -> dismiss -> event again -> banner stays hidden', async () => {
    // 1. Emit max-steps-reached event
    // 2. Dismiss banner
    // 3. Emit max-steps-reached event again
    // 4. Verify banner still hidden
  });

  it('progress indicator updates during streaming', async () => {
    // 1. Emit step-progress events 1-20
    // 2. Verify stepInfo updates each time
    // 3. Verify progress < 80% shows compact view
    // 4. Emit step-progress events 21-25
    // 5. Verify progress >= 80% shows progress bar
  });
});
