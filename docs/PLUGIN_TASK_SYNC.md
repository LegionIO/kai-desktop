# Plugin task-board sync

Kai plugins can integrate the Kanban / Tasks board with external work trackers
such as Jira, GitHub Issues, and Rally. The host exposes permission-gated task
reads and writes plus an origin-aware change hook for two-way synchronization.

## Manifest

```json
{
  "name": "jira-sync",
  "permissions": ["tasks:read", "tasks:write", "network:fetch"],
  "capabilities": ["tasks:sync"]
}
```

- `tasks:read` allows `list`, `get`, and `onChanged`.
- `tasks:write` allows `create`, `update`, `archive`, `unarchive`, and
  `upsertExternal`. It is elevated and requires explicit user consent.
- `tasks:sync` is the host capability for origin-aware task events and stable
  external identities. Declaring it prevents the plugin from loading on an
  older host that lacks this API.

Network and authentication access remain separately permissioned.

## Two-way sync pattern

```js
export async function activate(api) {
  api.tasks.onChanged(async (event) => {
    // Do not send an inbound write straight back to the remote system.
    if (event.origin.type === 'plugin' && event.origin.pluginName === api.pluginName) return;

    const ownLink = event.task?.externalLinks?.find(
      (link) => link.pluginName === api.pluginName && link.source === 'jira:acme',
    );
    if (!ownLink) return;

    await pushTaskToJira(ownLink.externalId, event.task, event.changedFields);
  });

  for (const issue of await pullIssuesFromJira()) {
    await api.tasks.upsertExternal(
      {
        external: {
          source: 'jira:acme',
          externalId: issue.id,
          externalKey: issue.key,
          url: issue.url,
          revision: issue.updatedAt,
        },
        task: {
          title: issue.summary,
          description: issue.description,
          status: mapJiraStatus(issue.status),
          priority: mapJiraPriority(issue.priority),
        },
      },
      { correlationId: `jira-pull:${issue.id}:${issue.updatedAt}` },
    );
  }
}
```

`upsertExternal` is idempotent by the tuple `(pluginName, source, externalId)`.
Kai stamps `pluginName` and `syncedAt`; a plugin cannot claim another plugin's
link. The optional `correlationId` is copied onto the resulting change event for
logging and finer-grained echo suppression.

Task cards display an external-key badge, and task detail views render each
validated HTTP(S) external URL as a link to the source tracker.

When a local card is pushed outward for the first time, pass its `taskId` after
the remote create succeeds. Kai attaches the new external identity to that card
instead of creating a second one:

```js
const remote = await createGitHubIssue(event.task);
await api.tasks.upsertExternal({
  taskId: event.taskId,
  external: {
    source: 'github:acme/product',
    externalId: String(remote.id),
    externalKey: `#${remote.number}`,
    url: remote.html_url,
  },
  task: {
    title: event.task.title,
    description: event.task.description,
    status: event.task.status,
  },
});
```

Task status writes follow Kai's task state machine. Plugins should map remote
states to valid transitions, and use `archive` for remote items that should no
longer appear on the active board. Hard deletion is intentionally not exposed
to plugins.
