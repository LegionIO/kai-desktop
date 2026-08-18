import { describe, it, expect } from 'vitest';
import { toolsForExecutionMode, PLAN_MODE_CUSTOM_TOOLS } from '../plan-mode-tools.js';

const tool = (name: string) => ({ name });

describe('toolsForExecutionMode (shared plan-mode tool filter — R129)', () => {
  it('is identity in auto mode', () => {
    const tools = [tool('ask_user'), tool('execute_command'), tool('mcp_write')];
    expect(toolsForExecutionMode(tools, 'auto')).toEqual(tools);
  });

  it('keeps only plan-mode-safe tools in plan-first (drops MCP/plugin/shell/write)', () => {
    const tools = [
      tool('ask_user'),
      tool('enter_plan_mode'),
      tool('exit_plan_mode'),
      tool('web_fetch'),
      tool('web_search'),
      tool('execute_command'), // shell — dropped
      tool('some_mcp_tool'), // MCP — dropped
      tool('a_plugin_action'), // plugin — dropped
    ];
    expect(toolsForExecutionMode(tools, 'plan-first').map((t) => t.name)).toEqual([
      'ask_user',
      'enter_plan_mode',
      'exit_plan_mode',
      'web_fetch',
      'web_search',
    ]);
  });

  it('exposes the allow-set (read-only planning tools only)', () => {
    expect([...PLAN_MODE_CUSTOM_TOOLS].sort()).toEqual(
      ['ask_user', 'enter_plan_mode', 'exit_plan_mode', 'web_fetch', 'web_search'].sort(),
    );
  });

  it('drops a NON-builtin tool that spoofs an allowlisted name (provenance check — R151)', () => {
    const tools = [
      { name: 'web_search', source: 'cli' as const }, // CLI tool named web_search backed by git/gh
      { name: 'web_search' }, // the genuine built-in (untagged source)
      { name: 'ask_user', source: 'plugin' as const }, // plugin spoof
      { name: 'ask_user', source: 'builtin' as const }, // genuine built-in
    ];
    const kept = toolsForExecutionMode(tools, 'plan-first');
    // Only the built-in / untagged copies survive; the CLI + plugin spoofs are dropped.
    expect(kept).toEqual([{ name: 'web_search' }, { name: 'ask_user', source: 'builtin' }]);
  });
});
