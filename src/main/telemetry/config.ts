/**
 * OpenTelemetry Configuration
 *
 * Centralized configuration for OpenTelemetry instrumentation
 * across Kai Desktop application components.
 *
 * All routing is driven by standard OTEL_* environment variables.
 * This module is backend-agnostic.
 *
 * Examples:
 *
 *   Agent / Collector (default):
 *     OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
 *     (all signals routed through the agent/collector)
 *
 *   Direct per-signal endpoints:
 *     OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://<collector>/v1/traces
 *     OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://<collector>/v1/metrics
 *     OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://<collector>/v1/logs
 *     OTEL_EXPORTER_OTLP_HEADERS=<key>=<value>
 *     (or per-signal: OTEL_EXPORTER_OTLP_TRACES_HEADERS, etc.)
 */

import os from 'os';

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;

  otlp: {
    /** Base endpoint — used when no per-signal override is set (e.g. http://localhost:4318) */
    endpoint: string;
    /** Per-signal endpoint overrides from OTEL_EXPORTER_OTLP_{SIGNAL}_ENDPOINT */
    tracesEndpoint?: string;
    metricsEndpoint?: string;
    logsEndpoint?: string;
    /** Shared headers for all signals, from OTEL_EXPORTER_OTLP_HEADERS */
    headers?: Record<string, string>;
    /** Per-signal header overrides */
    tracesHeaders?: Record<string, string>;
    metricsHeaders?: Record<string, string>;
    logsHeaders?: Record<string, string>;
    timeout?: number;
  };

  sampling: {
    tracesSampleRate: number;
  };

  features: {
    traces: boolean;
    metrics: boolean;
    logs: boolean;
    autoInstrumentation: boolean;
  };

  attributes: Record<string, string | number | boolean>;
}

/**
 * Parse a comma-separated key=value header string as returned by OTEL_EXPORTER_OTLP_HEADERS.
 * Returns undefined if the string is empty or not set.
 */
function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const result: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) result[key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Get telemetry configuration from environment variables or defaults.
 * No backend-specific logic — all routing determined by OTEL_* vars.
 */
export function getTelemetryConfig(): TelemetryConfig {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

  return {
    enabled: process.env.OTEL_ENABLED !== 'false' && !isTest,
    serviceName: process.env.OTEL_SERVICE_NAME || 'kai-desktop',
    serviceVersion: process.env.npm_package_version || '1.0.0',
    environment: process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'production',

    otlp: {
      endpoint: baseEndpoint,
      tracesEndpoint:  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      metricsEndpoint: process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
      logsEndpoint:    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      headers:         parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS),
      tracesHeaders:   parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
      metricsHeaders:  parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS),
      logsHeaders:     parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS),
      timeout: parseInt(process.env.OTEL_EXPORTER_OTLP_TIMEOUT || '10000', 10),
    },

    sampling: {
      tracesSampleRate: parseFloat(
        process.env.OTEL_TRACES_SAMPLER_ARG || (isDevelopment ? '1.0' : '0.1')
      ),
    },

    features: {
      traces:              process.env.OTEL_TRACES_ENABLED  !== 'false',
      metrics:             process.env.OTEL_METRICS_ENABLED !== 'false',
      logs:                process.env.OTEL_LOGS_ENABLED    !== 'false',
      autoInstrumentation: process.env.OTEL_AUTO_INSTRUMENTATION !== 'false',
    },

    attributes: {
      'deployment.environment': process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'production',
      'service.namespace': 'kai',
      'service.instance.id': `${process.pid}`,
      'process.runtime.name': 'electron',
      'process.runtime.version': process.versions.electron || 'unknown',
      'host.name': os.hostname(),
      'host.arch': process.arch,
      'host.platform': process.platform,
    },
  };
}

/**
 * Resolve the effective endpoint and headers for a given signal.
 * Uses the signal-specific override if set, otherwise falls back to base endpoint + path.
 * Per-signal headers are merged on top of shared headers.
 */
export function resolveSignalConfig(
  config: TelemetryConfig,
  signal: 'traces' | 'metrics' | 'logs'
): { url: string; headers: Record<string, string> | undefined } {
  const { otlp } = config;

  const urls = {
    traces:  otlp.tracesEndpoint  ?? `${otlp.endpoint}/v1/traces`,
    metrics: otlp.metricsEndpoint ?? `${otlp.endpoint}/v1/metrics`,
    logs:    otlp.logsEndpoint    ?? `${otlp.endpoint}/v1/logs`,
  };

  const signalHeaders = {
    traces:  otlp.tracesHeaders,
    metrics: otlp.metricsHeaders,
    logs:    otlp.logsHeaders,
  };

  const merged = signalHeaders[signal]
    ? { ...otlp.headers, ...signalHeaders[signal] }
    : otlp.headers;

  return { url: urls[signal], headers: merged };
}

/**
 * Recommended metric translator config for collectors that support per-metric translation options.
 * Set as a header value via OTEL_EXPORTER_OTLP_METRICS_HEADERS when targeting a compatible collector.
 */
export const OTLP_METRIC_TRANSLATOR_CONFIG = JSON.stringify({
  resource_attributes_as_tags: true,
  instrumentation_scope_metadata_as_tags: false,
  histograms: {
    mode: 'distributions',
    send_aggregation_metrics: true,
  },
  summaries: {
    mode: 'gauges',
  },
});
