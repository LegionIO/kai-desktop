import { describe, it, expect } from 'vitest';
import { isSubAgentToolCall } from '../sub-agent-routing';

describe('isSubAgentToolCall', () => {
  it('routes when toolName is sub_agent', () => {
    expect(isSubAgentToolCall('sub_agent')).toBe(true);
    expect(isSubAgentToolCall('sub_agent', null)).toBe(true);
  });

  it('routes when a subAgentConversationId is resolved and the name is unknown/absent', () => {
    // Backend bound this call's progress/result to a child — authoritative even
    // before the streamed tool-call name lands (parallel-spawn case).
    expect(isSubAgentToolCall('unknown', 'sub-123')).toBe(true);
    expect(isSubAgentToolCall(undefined, 'sub-123')).toBe(true);
  });

  it('does NOT route a known non-sub_agent tool even with a stray subAgentConversationId (security)', () => {
    // A KNOWN name is authoritative — a stray id can't promote a real tool to a
    // sub-agent card exposing another conversation.
    expect(isSubAgentToolCall('bash', 'sub-123')).toBe(false);
    expect(isSubAgentToolCall('read_file', 'sub-999')).toBe(false);
  });

  it('does not route an unknown/absent name with no resolved id', () => {
    expect(isSubAgentToolCall('unknown')).toBe(false);
    expect(isSubAgentToolCall('unknown', null)).toBe(false);
    expect(isSubAgentToolCall(undefined)).toBe(false);
    expect(isSubAgentToolCall(undefined, null)).toBe(false);
  });
});
