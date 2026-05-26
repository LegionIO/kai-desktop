/**
 * Unit tests for `warnOnDeprecatedField` (electron/utils/field-validation.ts).
 *
 * Three cases cover the helper's three behavioral branches:
 *   1. deprecated key present + expected key missing -> warns once
 *   2. expected key already populated (with or without deprecated) -> silent
 *   3. non-object input (null, string, number) -> silent
 *
 * Locks the silent-no-op contract callers in agents.ts / tasks.ts depend on.
 */

import { describe, it, expect, vi } from 'vitest';
import { warnOnDeprecatedField } from '../field-validation.js';

describe('warnOnDeprecatedField', () => {
  it('warns when deprecated key is set and expected key is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnDeprecatedField(
      { assignedAgent: 'a-1' },
      'assignedAgent',
      'assignedAgentId',
      'tasks',
      'Task',
      't-7',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /\[tasks\] Task t-7 has deprecated field 'assignedAgent'/,
    );
    warn.mockRestore();
  });

  it('does not warn when expected key is already populated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnDeprecatedField(
      { assignedAgent: 'a-1', assignedAgentId: 'a-2' },
      'assignedAgent',
      'assignedAgentId',
      'tasks',
      'Task',
      't-7',
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is a no-op for null / non-object inputs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnOnDeprecatedField(null, 'a', 'b', 'tasks', 'Task', 't');
    warnOnDeprecatedField('string', 'a', 'b', 'tasks', 'Task', 't');
    warnOnDeprecatedField(42, 'a', 'b', 'tasks', 'Task', 't');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
