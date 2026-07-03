import type { IpcMain } from 'electron';
import type { AutomationEngine } from '../automations/engine.js';
import type { AutomationEventBus } from '../automations/event-bus.js';
import type { AutomationRunRecord, SourceCatalogEntry } from '../automations/types.js';

export function registerAutomationsHandlers(ipcMain: IpcMain, engine: AutomationEngine, bus: AutomationEventBus): void {
  ipcMain.handle('automations:catalog', (): SourceCatalogEntry[] => bus.getCatalog());

  ipcMain.handle('automations:log', (): AutomationRunRecord[] => engine.getRunLog());

  ipcMain.handle('automations:test', (_event, ruleId: string, samplePayload: unknown) =>
    engine.testRule(ruleId, samplePayload),
  );

  ipcMain.handle('automations:emit', (_event, source: string, event: string, payload?: unknown) => {
    bus.emit(source, event, payload);
  });
}
