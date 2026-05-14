// @vitest-environment jsdom
import { describe, it } from 'vitest';

describe('RuntimeProvider - Step Tracking', () => {
  describe('step-progress event handling', () => {
    it.todo('updates stepInfo state when step-progress event received');
    it.todo('only updates stepInfo for active conversation');
  });

  describe('max-steps-reached event handling', () => {
    it.todo('shows incomplete task banner when limit reached');
    it.todo('does not show banner if conversation dismissed');
    it.todo('logs warning when max steps reached');
  });

  describe('handleContinueTask', () => {
    it.todo('sends continuation message');
    it.todo('hides banner and clears stepInfo');
    it.todo('does not continue if already running');
  });

  describe('handleAdjustSettings', () => {
    it.todo('dispatches kai:open-settings event');
    it.todo('navigates to advanced section after delay');
    it.todo('hides banner when called');
  });

  describe('handleDismissBanner', () => {
    it.todo('adds conversation to dismissed set');
    it.todo('hides banner');
    it.todo('logs dismissal');
  });

  describe('StepTrackingContext', () => {
    it.todo('provides stepInfo to consumers');
    it.todo('provides showIncompleteTaskBanner state');
    it.todo('provides all callback functions');
  });
});

describe('Step Tracking - Integration', () => {
  it.todo('full flow: receive event -> show banner -> continue -> hide banner');
  it.todo('full flow: receive event -> dismiss -> event again -> banner stays hidden');
  it.todo('progress indicator updates during streaming');
});
