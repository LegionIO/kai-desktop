import { describe, expect, it } from 'vitest';
import { resolveLaunchView } from '../launch-view';

const panels = [{ pluginName: 'pim', id: 'main', visible: true }];

describe('resolveLaunchView', () => {
  it('skips chats and unknown values', () => {
    expect(resolveLaunchView('chats', {}, [])).toEqual({ kind: 'skip' });
    expect(resolveLaunchView('nope', {}, [])).toEqual({ kind: 'skip' });
  });
  it('maps built-in screens', () => {
    expect(resolveLaunchView('tasks', {}, [])).toEqual({ kind: 'go', section: 'tasks', view: 'tasks' });
    expect(resolveLaunchView('plugins', {}, [])).toEqual({ kind: 'go', section: 'plugins', view: 'marketplace' });
  });
  it('waits for a plugin until it is active with a panel', () => {
    expect(resolveLaunchView('plugin:pim', undefined, undefined)).toEqual({ kind: 'wait' });
    expect(resolveLaunchView('plugin:pim', { pim: 'disabled' }, [])).toEqual({ kind: 'wait' });
    expect(resolveLaunchView('plugin:pim', { pim: 'loading' }, panels)).toEqual({ kind: 'wait' });
    expect(resolveLaunchView('plugin:pim', { pim: 'active' }, [])).toEqual({ kind: 'wait' });
    expect(resolveLaunchView('plugin:pim', { pim: 'active' }, panels)).toEqual({
      kind: 'go',
      section: 'plugins',
      view: 'plugin-panel:pim:main',
    });
  });
  it('gives up when the plugin errors', () => {
    expect(resolveLaunchView('plugin:pim', { pim: 'error' }, panels)).toEqual({ kind: 'skip' });
  });
});
