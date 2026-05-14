/**
 * OpenTelemetry Bootstrap
 *
 * Initializes telemetry BEFORE any other application code runs.
 * This file should be imported at the very top of the main entry point.
 */

import { initializeTelemetry, shutdownTelemetry } from '../src/main/telemetry/index.js';
import { startSystemMetricsCollection } from '../src/main/telemetry/metrics.js';

let metricsInterval: NodeJS.Timeout | null = null;

/**
 * Initialize telemetry for the Electron main process.
 * Call this BEFORE any other initialization.
 */
export async function bootstrapTelemetry(): Promise<void> {
  try {
    await initializeTelemetry();

    metricsInterval = startSystemMetricsCollection(60000);

    console.info('[Telemetry] Bootstrap complete');
  } catch (error) {
    console.error('[Telemetry] Bootstrap failed:', error);
  }
}

/**
 * Shutdown telemetry gracefully.
 * Call this during application quit.
 */
export async function shutdownTelemetryBootstrap(): Promise<void> {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }

  await shutdownTelemetry();
}
