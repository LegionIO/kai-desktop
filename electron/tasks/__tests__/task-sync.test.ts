import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { PluginTaskChangeEvent } from '../../plugins/types.js';

vi.mock('../../utils/window-send.js', () => ({ broadcastToAllWindows: vi.fn() }));

const {
  archivePluginTask,
  broadcastTaskChange,
  createPluginTask,
  listTasks,
  unarchivePluginTask,
  updatePluginTask,
  upsertExternalPluginTask,
} = await import('../../ipc/tasks.js');
const { resetTaskSyncStateForTests, subscribeToTaskChanges } = await import('../task-sync.js');

let appHome: string;

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'kai-task-sync-'));
  resetTaskSyncStateForTests();
});

afterEach(() => {
  resetTaskSyncStateForTests();
  rmSync(appHome, { recursive: true, force: true });
});

function collectChanges(): PluginTaskChangeEvent[] {
  const events: PluginTaskChangeEvent[] = [];
  subscribeToTaskChanges(appHome, listTasks(appHome, { includeArchived: true }), (event) => {
    events.push(event);
  });
  return events;
}

describe('plugin task-board sync', () => {
  it('publishes origin-aware create and update events for echo suppression', async () => {
    const events = collectChanges();
    const created = createPluginTask(
      appHome,
      'jira-sync',
      { title: 'Fix login', description: 'Remote issue', status: 'todo' },
      { correlationId: 'pull-42' },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'created',
      taskId: created.id,
      origin: { type: 'plugin', pluginName: 'jira-sync', correlationId: 'pull-42' },
    });

    await updatePluginTask(
      appHome,
      'jira-sync',
      created.id,
      { title: 'Fix SSO login', status: 'in_progress' },
      { correlationId: 'pull-43' },
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'updated',
      taskId: created.id,
      origin: { type: 'plugin', pluginName: 'jira-sync', correlationId: 'pull-43' },
    });
    expect(events[1].changedFields).toContain('title');
    expect(events[1].changedFields).toContain('status');
    expect(events[1].task?.startedAt).toBeTruthy();
  });

  it('upserts external work items idempotently and namespaces identity by plugin', async () => {
    const input = {
      external: {
        source: 'jira:acme',
        externalId: '10001',
        externalKey: 'ENG-42',
        url: 'https://acme.atlassian.net/browse/ENG-42',
        revision: '7',
      },
      task: { title: 'Ship task sync', description: 'Keep both boards aligned', status: 'todo' as const },
    };

    const first = await upsertExternalPluginTask(appHome, 'jira-sync', input, { correlationId: 'poll-1' });
    const second = await upsertExternalPluginTask(appHome, 'jira-sync', input, { correlationId: 'poll-2' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(listTasks(appHome, { includeArchived: true })).toHaveLength(1);
    expect(second.task.externalLinks).toEqual([
      expect.objectContaining({
        pluginName: 'jira-sync',
        source: 'jira:acme',
        externalId: '10001',
        externalKey: 'ENG-42',
        revision: '7',
      }),
    ]);

    const otherPlugin = await upsertExternalPluginTask(appHome, 'rally-sync', input);
    expect(otherPlugin.created).toBe(true);
    expect(otherPlugin.task.id).not.toBe(first.task.id);
    expect(listTasks(appHome, { includeArchived: true })).toHaveLength(2);
  });

  it('attaches an outbound-created external item to its existing local task', async () => {
    const localTask = createPluginTask(appHome, 'github-sync', { title: 'Publish release notes' });

    const linked = await upsertExternalPluginTask(appHome, 'github-sync', {
      taskId: localTask.id,
      external: {
        source: 'github:acme/product',
        externalId: '9001',
        externalKey: '#54',
        revision: '2026-01-01T00:00:00Z',
      },
      task: { title: localTask.title, description: localTask.description, status: localTask.status },
    });

    expect(linked.created).toBe(false);
    expect(linked.task.id).toBe(localTask.id);
    expect(linked.task.externalLinks).toEqual([
      expect.objectContaining({
        pluginName: 'github-sync',
        source: 'github:acme/product',
        externalId: '9001',
      }),
    ]);
    expect(listTasks(appHome, { includeArchived: true })).toHaveLength(1);
  });

  it('preserves concurrent external links attached to the same local task', async () => {
    const localTask = createPluginTask(appHome, 'bridge-sync', { title: 'Cross-system work item' });
    const task = { title: localTask.title, description: localTask.description, status: localTask.status };

    await Promise.all([
      upsertExternalPluginTask(appHome, 'bridge-sync', {
        taskId: localTask.id,
        external: { source: 'github:acme/product', externalId: '54' },
        task,
      }),
      upsertExternalPluginTask(appHome, 'bridge-sync', {
        taskId: localTask.id,
        external: { source: 'jira:acme', externalId: 'ENG-42' },
        task,
      }),
    ]);

    const links = listTasks(appHome, { includeArchived: true })[0].externalLinks ?? [];
    expect(links).toHaveLength(2);
    expect(links.map((link) => `${link.source}:${link.externalId}`).sort()).toEqual([
      'github:acme/product:54',
      'jira:acme:ENG-42',
    ]);
  });

  it('limits plugin updates to user-owned board fields', async () => {
    const task = createPluginTask(appHome, 'github-sync', { title: 'Review PR' });

    await expect(
      updatePluginTask(appHome, 'github-sync', task.id, {
        assignedAgentId: 'forged-agent',
      } as never),
    ).rejects.toThrow('Invalid plugin task update');

    expect(listTasks(appHome)[0].assignedAgentId).toBeUndefined();
  });

  it('rejects non-HTTP external links before they reach task data', async () => {
    await expect(
      upsertExternalPluginTask(appHome, 'github-sync', {
        external: { source: 'github:acme/product', externalId: '54', url: 'javascript:alert(1)' },
        task: { title: 'Unsafe link' },
      }),
    ).rejects.toThrow('Invalid external task upsert');
    expect(listTasks(appHome, { includeArchived: true })).toEqual([]);
  });

  it('emits archive, unarchive, and system deletion events', async () => {
    const events = collectChanges();
    const task = createPluginTask(appHome, 'github-sync', { title: 'Review PR' });
    events.length = 0;

    await archivePluginTask(appHome, 'github-sync', task.id, { correlationId: 'archive-1' });
    expect(events[0]).toMatchObject({ type: 'archived', taskId: task.id });
    expect(listTasks(appHome)).toEqual([]);

    unarchivePluginTask(appHome, 'github-sync', task.id, { correlationId: 'restore-1' });
    expect(events[1]).toMatchObject({ type: 'unarchived', taskId: task.id });
    expect(listTasks(appHome)).toHaveLength(1);

    unlinkSync(join(appHome, 'data', 'tasks', `${task.id}.json`));
    broadcastTaskChange(appHome, { type: 'system' });
    expect(events[2]).toMatchObject({
      type: 'deleted',
      taskId: task.id,
      origin: { type: 'system' },
    });
  });
});
