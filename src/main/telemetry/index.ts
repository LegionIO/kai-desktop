/**
 * OpenTelemetry Main Process Instrumentation
 * 
 * Initializes OpenTelemetry SDK for the Electron main process
 * with traces, metrics, and auto-instrumentation support.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getTelemetryConfig, validateTelemetryConfig } from './config';
import type { TelemetryConfig } from './config';
import {
  enhanceConfigForDatadog,
  validateDatadogConfig,
  logDatadogConfig,
  checkDatadogAgentStatus
} from './datadog-config';

let sdk: NodeSDK | null = null;
let isInitialized = false;

/**
 * Initialize OpenTelemetry for the main process
 */
export async function initializeTelemetry(): Promise<void> {
  if (isInitialized) {
    console.warn('[Telemetry] Already initialized');
    return;
  }

  let config = getTelemetryConfig();

  if (!config.enabled) {
    console.log('[Telemetry] Disabled by configuration');
    return;
  }

  try {
    // Enhance config with Datadog-specific attributes
    config = enhanceConfigForDatadog(config);

    validateTelemetryConfig(config);

    // Validate Datadog-specific configuration
    const ddValidation = validateDatadogConfig();
    if (!ddValidation.valid) {
      console.error('[Datadog] Configuration errors:', ddValidation.errors);
      throw new Error(`Datadog configuration invalid: ${ddValidation.errors.join(', ')}`);
    }

    // Log Datadog configuration
    logDatadogConfig();

    // Check Datadog Agent status if using local agent
    if (config.otlp.endpoint.includes('localhost') || config.otlp.endpoint.includes('127.0.0.1')) {
      const agentStatus = await checkDatadogAgentStatus();
      if (!agentStatus.running) {
        console.warn('[Datadog] Agent not detected. Make sure Datadog Agent is running with OTLP receiver enabled.');
        console.warn('[Datadog] Error:', agentStatus.error);
      } else {
        console.info('[Datadog] Agent detected:', {
          version: agentStatus.version,
          otlpEnabled: agentStatus.otlpEnabled,
        });
        if (!agentStatus.otlpEnabled) {
          console.warn('[Datadog] OTLP receiver may not be enabled in Agent. Traces may not appear.');
        }
      }
    }

    console.log('[Telemetry] Initializing OpenTelemetry SDK', {
      serviceName: config.serviceName,
      environment: config.environment,
      endpoint: config.otlp.endpoint,
    });

    const resource = createResource(config);
    const traceExporter = createTraceExporter(config);
    const metricReader = createMetricReader(config);

    sdk = new NodeSDK({
      resource,
      spanProcessors: config.features.traces
        ? [new BatchSpanProcessor(traceExporter)]
        : [],
      metricReader: config.features.metrics ? metricReader : undefined,
      instrumentations: config.features.autoInstrumentation
        ? [
            getNodeAutoInstrumentations({
              '@opentelemetry/instrumentation-fs': { enabled: false }, // Too noisy
              '@opentelemetry/instrumentation-dns': { enabled: false }, // Too noisy
            }),
          ]
        : [],
    });

    await sdk.start();
    isInitialized = true;

    console.log('[Telemetry] OpenTelemetry SDK started successfully');
    console.info('[Datadog] Traces will appear at: https://app.datadoghq.com/apm/traces');

    // Graceful shutdown on process exit
    process.on('SIGTERM', () => shutdownTelemetry());
    process.on('SIGINT', () => shutdownTelemetry());
    process.on('exit', () => {
      if (isInitialized) {
        sdk?.shutdown().catch(console.error);
      }
    });

  } catch (error) {
    console.error('[Telemetry] Failed to initialize OpenTelemetry', error);
    throw error;
  }
}

/**
 * Shutdown OpenTelemetry SDK gracefully
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!isInitialized || !sdk) {
    return;
  }

  console.log('[Telemetry] Shutting down OpenTelemetry SDK');
  
  try {
    await sdk.shutdown();
    isInitialized = false;
    sdk = null;
    console.log('[Telemetry] OpenTelemetry SDK shut down successfully');
  } catch (error) {
    console.error('[Telemetry] Error shutting down OpenTelemetry SDK', error);
  }
}

/**
 * Create OpenTelemetry Resource with service metadata
 */
function createResource(config: TelemetryConfig): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    ...config.attributes,
  });
}

/**
 * Create OTLP Trace Exporter
 */
function createTraceExporter(config: TelemetryConfig): OTLPTraceExporter {
  return new OTLPTraceExporter({
    url: `${config.otlp.endpoint}/v1/traces`,
    headers: config.otlp.headers,
    timeoutMillis: config.otlp.timeout,
  });
}

/**
 * Create Metric Reader with OTLP exporter
 */
function createMetricReader(config: TelemetryConfig): PeriodicExportingMetricReader {
  const exporter = new OTLPMetricExporter({
    url: `${config.otlp.endpoint}/v1/metrics`,
    headers: config.otlp.headers,
    timeoutMillis: config.otlp.timeout,
  });

  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 60000, // Export every 60 seconds
  });
}

/**
 * Check if telemetry is initialized
 */
export function isTelemetryInitialized(): boolean {
  return isInitialized;
}
