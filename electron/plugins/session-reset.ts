import { clearPluginBrowserPartitions } from '../browser/plugin-partitions.js';

/** A destructive reset may only target the calling plugin's named partitions. */
export function pluginResetStorageName(pluginName: string, partition: string): string {
  const prefix = `persist:kai-${pluginName}-`;
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(pluginName) ||
    !partition.startsWith(prefix) ||
    !/^[a-z0-9-]+$/.test(partition.slice(prefix.length))
  ) {
    throw new Error('Session reset requires a persistent partition owned by this plugin.');
  }
  return partition.slice('persist:'.length);
}

export async function resetPluginSession(pluginName: string, partition: string): Promise<void> {
  await clearPluginBrowserPartitions([pluginResetStorageName(pluginName, partition)]);
}
