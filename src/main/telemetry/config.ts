/**
 * OpenTelemetry Configuration
 * 
 * Centralized configuration for OpenTelemetry instrumentation
 * across Kai Desktop application components.
 */

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  
  // OTLP Exporter Configuration
  otlp: {
    endpoint: string;
    headers?: Record<string, string>;
    timeout?: number;
  };
  
  // Sampling Configuration
  sampling: {
    tracesSampleRate: number;
    metricsSampleRate: number;
  };
  
  // Feature Flags
  features: {
    traces: boolean;
    metrics: boolean;
    logs: boolean;
    autoInstrumentation: boolean;
  };
  
  // Resource Attributes
  attributes: Record<string, string | number | boolean>;
}

/**
 * Get telemetry configuration from environment variables or defaults
 */
export function getTelemetryConfig(): TelemetryConfig {
  const isDevelopment = process.env.NODE_ENV === 'development';
  const isTest = process.env.NODE_ENV === 'test';
  
  return {
    enabled: process.env.OTEL_ENABLED !== 'false' && !isTest,
    serviceName: process.env.OTEL_SERVICE_NAME || 'kai-desktop',
    serviceVersion: process.env.npm_package_version || '1.0.0',
    environment: process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'production',
    
    otlp: {
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318',
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS 
        ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS)
        : undefined,
      timeout: parseInt(process.env.OTEL_EXPORTER_OTLP_TIMEOUT || '10000', 10),
    },
    
    sampling: {
      tracesSampleRate: parseFloat(process.env.OTEL_TRACES_SAMPLER_ARG || (isDevelopment ? '1.0' : '0.1')),
      metricsSampleRate: 1.0,
    },
    
    features: {
      traces: process.env.OTEL_TRACES_ENABLED !== 'false',
      metrics: process.env.OTEL_METRICS_ENABLED !== 'false',
      logs: process.env.OTEL_LOGS_ENABLED !== 'false',
      autoInstrumentation: process.env.OTEL_AUTO_INSTRUMENTATION !== 'false',
    },
    
    attributes: {
      'deployment.environment': process.env.OTEL_ENVIRONMENT || process.env.NODE_ENV || 'production',
      'service.namespace': 'kai',
      'service.instance.id': `${process.pid}`,
      'process.runtime.name': 'electron',
      'process.runtime.version': process.versions.electron || 'unknown',
      'host.name': require('os').hostname(),
      'host.arch': process.arch,
      'host.platform': process.platform,
    },
  };
}

/**
 * Validate telemetry configuration
 */
export function validateTelemetryConfig(config: TelemetryConfig): void {
  if (!config.serviceName) {
    throw new Error('OTEL_SERVICE_NAME must be set');
  }
  
  if (config.sampling.tracesSampleRate < 0 || config.sampling.tracesSampleRate > 1) {
    throw new Error('OTEL_TRACES_SAMPLER_ARG must be between 0 and 1');
  }
  
  try {
    new URL(config.otlp.endpoint);
  } catch (error) {
    throw new Error(`Invalid OTEL_EXPORTER_OTLP_ENDPOINT: ${config.otlp.endpoint}`);
  }
}
