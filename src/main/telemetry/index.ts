/**
 * OpenTelemetry Main Process Instrumentation
 *
 * Initializes the OpenTelemetry Node SDK for the Electron main process with
 * separate per-signal exporters for traces, metrics, and logs.
 *
 * Routing is fully driven by OTEL_* environment variables.
 * See config.ts for supported env var documentation.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getTelemetryConfig, resolveSignalConfig } from './config';
import type { TelemetryConfig } from './config';

let sdk: NodeSDK | null = null;
let isInitialized = false;

/**
 * Initialize OpenTelemetry for the main process.
 * Safe to call at startup — will never throw; errors are logged and telemetry is skipped.
 */
export async function initializeTelemetry(): Promise<void> {
  if (isInitialized) {
    console.warn('[Telemetry] Already initialized');
    return;
  }

  const config = getTelemetryConfig();

  if (!config.enabled) {
    console.info('[Telemetry] Disabled by configuration (OTEL_ENABLED=false or test env)');
    return;
  }

  try {
    console.info('[Telemetry] Initializing OpenTelemetry SDK', {
      serviceName: config.serviceName,
      serviceVersion: config.serviceVersion,
      environment: config.environment,
      baseEndpoint: config.otlp.endpoint,
    });

    const resource = createResource(config);
    const spanProcessors = createSpanProcessors(config);
    const metricReader = config.features.metrics ? createMetricReader(config) : undefined;
    const logRecordProcessors = config.features.logs ? createLogProcessors(config) : undefined;

    sdk = new NodeSDK({
      resource,
      spanProcessors,
      metricReader,
      logRecordProcessors,
      instrumentations: config.features.autoInstrumentation
        ? [
            getNodeAutoInstrumentations({
              '@opentelemetry/instrumentation-fs': { enabled: false },
              '@opentelemetry/instrumentation-dns': { enabled: false },
            }),
          ]
        : [],
    });

    await sdk.start();
    isInitialized = true;

    console.info('[Telemetry] OpenTelemetry SDK started', {
      traces: config.features.traces,
      metrics: config.features.metrics,
      logs: config.features.logs,
      tracesEndpoint: resolveSignalConfig(config, 'traces').url,
      metricsEndpoint: resolveSignalConfig(config, 'metrics').url,
      logsEndpoint: resolveSignalConfig(config, 'logs').url,
    });

    process.on('SIGTERM', () => { shutdownTelemetry().catch(console.error); });
    process.on('SIGINT',  () => { shutdownTelemetry().catch(console.error); });
    process.on('exit', () => {
      if (isInitialized) {
        sdk?.shutdown().catch(console.error);
      }
    });

  } catch (error) {
    console.error('[Telemetry] Failed to initialize OpenTelemetry — continuing without telemetry', error);
  }
}

/**
 * Shutdown OpenTelemetry SDK gracefully.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!isInitialized || !sdk) {
    return;
  }

  console.info('[Telemetry] Shutting down OpenTelemetry SDK');

  try {
    await sdk.shutdown();
    isInitialized = false;
    sdk = null;
    console.info('[Telemetry] OpenTelemetry SDK shut down successfully');
  } catch (error) {
    console.error('[Telemetry] Error shutting down OpenTelemetry SDK', error);
  }
}

/**
 * Check if telemetry is initialized.
 */
export function isTelemetryInitialized(): boolean {
  return isInitialized;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function createResource(config: TelemetryConfig) {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    ...config.attributes,
  });
}

function createSpanProcessors(config: TelemetryConfig): BatchSpanProcessor[] {
  if (!config.features.traces) return [];

  const { url, headers } = resolveSignalConfig(config, 'traces');
  const traceExporter = new OTLPTraceExporter({
    url,
    headers,
    timeoutMillis: config.otlp.timeout,
  });

  return [new BatchSpanProcessor(traceExporter)];
}

function createMetricReader(config: TelemetryConfig): PeriodicExportingMetricReader {
  const { url, headers } = resolveSignalConfig(config, 'metrics');

  const exporter = new OTLPMetricExporter({
    url,
    headers,
    timeoutMillis: config.otlp.timeout,
    // Delta temporality is broadly compatible with OTLP collectors and required
    // by some direct intake endpoints (e.g. vendor OTLP APIs).
    temporalityPreference: AggregationTemporalityPreference.DELTA,
  });

  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60_000,
  });
}

function createLogProcessors(config: TelemetryConfig): SimpleLogRecordProcessor[] {
  const { url, headers } = resolveSignalConfig(config, 'logs');

  const logExporter = new OTLPLogExporter({
    url,
    headers,
    timeoutMillis: config.otlp.timeout,
  });

  return [new SimpleLogRecordProcessor(logExporter)];
}
