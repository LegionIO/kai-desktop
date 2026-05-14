/**
 * Datadog-Specific OpenTelemetry Configuration
 *
 * Enhances base OpenTelemetry config with Datadog-specific requirements:
 * - Unified Service Tagging (env/service/version)
 * - Datadog resource attributes
 * - Datadog Agent OTLP endpoint detection
 * - Datadog semantic conventions
 */

import type { TelemetryConfig } from './config';
import { getTelemetryConfig } from './config';

export interface DatadogConfig {
  /** Datadog API key (only needed for direct intake) */
  apiKey?: string;

  /** Datadog site (datadoghq.com, datadoghq.eu, etc.) */
  site: string;

  /** Use Datadog Agent locally vs direct intake */
  useAgent: boolean;

  /** Unified Service Tagging */
  tags: {
    env: string;
    service: string;
    version: string;
  };
}

/**
 * Get Datadog-specific configuration
 */
export function getDatadogConfig(): DatadogConfig {
  const baseConfig = getTelemetryConfig();

  // Detect if using Datadog Agent (localhost) or direct intake
  const useAgent = baseConfig.otlp.endpoint.includes('localhost') ||
                   baseConfig.otlp.endpoint.includes('127.0.0.1');

  // Extract DD_SITE from environment or default to US1
  const site = process.env.DD_SITE || 'datadoghq.com';

  // Get API key (only needed for direct intake)
  const apiKey = process.env.DD_API_KEY;

  // Unified Service Tagging (Datadog best practice)
  const tags = {
    env: process.env.DD_ENV || baseConfig.environment,
    service: process.env.DD_SERVICE || baseConfig.serviceName,
    version: process.env.DD_VERSION || baseConfig.serviceVersion,
  };

  return {
    apiKey,
    site,
    useAgent,
    tags,
  };
}

/**
 * Enhance base telemetry config with Datadog-specific attributes
 */
export function enhanceConfigForDatadog(config: TelemetryConfig): TelemetryConfig {
  const ddConfig = getDatadogConfig();

  // Add Datadog-specific resource attributes
  const datadogAttributes = {
    // Unified Service Tagging
    'env': ddConfig.tags.env,
    'service': ddConfig.tags.service,
    'version': ddConfig.tags.version,

    // Datadog-specific attributes
    'dd.service': ddConfig.tags.service,
    'dd.env': ddConfig.tags.env,
    'dd.version': ddConfig.tags.version,

    // Runtime attributes (useful for Datadog APM)
    'runtime.name': 'electron',
    'runtime.version': process.versions.electron || 'unknown',

    // Deployment attributes
    'deployment.environment': ddConfig.tags.env,
  };

  // Merge with existing attributes
  const enhancedConfig = {
    ...config,
    attributes: {
      ...config.attributes,
      ...datadogAttributes,
    },
  };

  // If using direct intake (not agent), update headers and endpoint
  if (!ddConfig.useAgent && ddConfig.apiKey) {
    enhancedConfig.otlp.headers = {
      ...enhancedConfig.otlp.headers,
      'dd-api-key': ddConfig.apiKey,
    };

    // Update endpoint for direct OTLP intake
    // Datadog's OTLP intake base endpoint (SDK appends /v1/traces automatically)
    if (!enhancedConfig.otlp.endpoint.includes('http-intake.logs')) {
      enhancedConfig.otlp.endpoint = `https://http-intake.logs.${ddConfig.site}`;
    }
  }

  return enhancedConfig;
}

/**
 * Validate Datadog configuration
 */
export function validateDatadogConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const ddConfig = getDatadogConfig();
  const baseConfig = getTelemetryConfig();

  // Check if using direct intake without API key
  if (!ddConfig.useAgent && !ddConfig.apiKey) {
    errors.push('DD_API_KEY is required when using direct Datadog intake (not localhost)');
  }

  // Validate Unified Service Tagging
  if (!ddConfig.tags.env) {
    errors.push('env tag is required for Datadog (set OTEL_ENVIRONMENT or DD_ENV)');
  }

  if (!ddConfig.tags.service) {
    errors.push('service tag is required for Datadog (set OTEL_SERVICE_NAME or DD_SERVICE)');
  }

  if (!ddConfig.tags.version) {
    errors.push('version tag is required for Datadog (set OTEL_SERVICE_VERSION or DD_VERSION)');
  }

  // Validate endpoint
  if (ddConfig.useAgent) {
    // Check if localhost endpoint is reachable (optional, non-blocking)
    console.info('[Datadog] Using local Datadog Agent at', baseConfig.otlp.endpoint);
    console.info('[Datadog] Ensure Agent has OTLP receiver enabled');
  } else {
    console.info('[Datadog] Using direct Datadog intake at', `https://api.${ddConfig.site}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get Datadog Agent status (checks if agent is running locally)
 */
export async function checkDatadogAgentStatus(): Promise<{
  running: boolean;
  otlpEnabled: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    // Try to get agent status
    const { stdout } = await execFileAsync('datadog-agent', ['status'], {
      timeout: 5000,
    });

    const running = stdout.includes('Agent running');
    const otlpEnabled = stdout.includes('otlp') || stdout.includes('OTLP');

    // Extract version
    const versionMatch = stdout.match(/Agent \(v([\d.]+)\)/);
    const version = versionMatch ? versionMatch[1] : undefined;

    return {
      running,
      otlpEnabled,
      version,
    };
  } catch (error) {
    return {
      running: false,
      otlpEnabled: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get Datadog APM trace URL for a given trace ID
 */
export function getDatadogTraceUrl(traceId: string): string {
  const ddConfig = getDatadogConfig();
  const site = ddConfig.site;

  // Convert OpenTelemetry trace ID (32 hex chars) to Datadog trace ID (64-bit decimal)
  // Datadog uses the lower 64 bits of the trace ID
  const lower64Bits = traceId.slice(16, 32);
  const datadogTraceId = BigInt('0x' + lower64Bits).toString(10);

  return `https://app.${site}/apm/trace/${datadogTraceId}`;
}

/**
 * Log Datadog configuration on startup (useful for debugging)
 */
export function logDatadogConfig(): void {
  const ddConfig = getDatadogConfig();
  const baseConfig = getTelemetryConfig();

  console.info('[Datadog OpenTelemetry Configuration]');
  console.info('  Integration Mode:', ddConfig.useAgent ? 'Agent (Local)' : 'Direct Intake (Cloud)');
  console.info('  Endpoint:', baseConfig.otlp.endpoint);
  console.info('  Site:', ddConfig.site);
  console.info('  Unified Service Tags:');
  console.info('    - env:', ddConfig.tags.env);
  console.info('    - service:', ddConfig.tags.service);
  console.info('    - version:', ddConfig.tags.version);

  if (ddConfig.useAgent) {
    console.info('  ⚠️  Ensure Datadog Agent has OTLP receiver enabled');
    console.info('     See: https://docs.datadoghq.com/opentelemetry/otlp_ingest_in_the_agent/');
  }
}
