/**
 * OpenTelemetry Renderer Process Instrumentation
 * 
 * Lightweight telemetry for the Electron renderer process
 * with web vitals and user interaction tracking.
 */

import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Tracer, Attributes } from '@opentelemetry/api';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { UserInteractionInstrumentation } from '@opentelemetry/instrumentation-user-interaction';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';

let provider: WebTracerProvider | null = null;
let isInitialized = false;

export interface RendererTelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  endpoint: string;
  sampleRate: number;
}

/**
 * Initialize OpenTelemetry for renderer process
 */
export async function initializeRendererTelemetry(
  config: RendererTelemetryConfig
): Promise<void> {
  if (isInitialized) {
    console.warn('[Telemetry] Renderer already initialized');
    return;
  }

  if (!config.enabled) {
    console.log('[Telemetry] Renderer telemetry disabled');
    return;
  }

  try {
    console.log('[Telemetry] Initializing renderer telemetry', config);

    const resource: Resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: `${config.serviceName}-renderer`,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      'deployment.environment': config.environment,
      'service.namespace': 'kai',
      'process.type': 'renderer',
    });

    const exporter = new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
    });

    provider = new WebTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
      sampler: {
        shouldSample: () => {
          return Math.random() < config.sampleRate
            ? { decision: 1 } // RECORD_AND_SAMPLED
            : { decision: 0 }; // NOT_RECORD
        },
        toString: () => `TraceIdRatioBasedSampler{${config.sampleRate}}`,
      },
    });

    provider.register();

    // Register auto-instrumentations
    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [
        new DocumentLoadInstrumentation(),
        new UserInteractionInstrumentation({
          eventNames: ['click', 'submit', 'change'],
        }),
        new FetchInstrumentation({
          propagateTraceHeaderCorsUrls: /.*/,
          clearTimingResources: true,
        }),
      ],
    });

    isInitialized = true;
    console.log('[Telemetry] Renderer telemetry initialized successfully');
  } catch (error) {
    console.error('[Telemetry] Failed to initialize renderer telemetry', error);
    throw error;
  }
}

/**
 * Shutdown renderer telemetry
 */
export async function shutdownRendererTelemetry(): Promise<void> {
  if (!isInitialized || !provider) {
    return;
  }

  console.log('[Telemetry] Shutting down renderer telemetry');
  
  try {
    await provider.shutdown();
    isInitialized = false;
    provider = null;
    console.log('[Telemetry] Renderer telemetry shut down successfully');
  } catch (error) {
    console.error('[Telemetry] Error shutting down renderer telemetry', error);
  }
}

/**
 * Get tracer for renderer
 */
export function getRendererTracer(name: string = 'kai-renderer'): Tracer {
  return trace.getTracer(name);
}

/**
 * Trace a React component render
 */
export function traceComponentRender(
  componentName: string,
  renderFn: () => void
): void {
  const tracer = getRendererTracer();
  const span = tracer.startSpan(`component.render.${componentName}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'component.name': componentName,
      'component.type': 'react',
    },
  });

  try {
    renderFn();
    span.setStatus({ code: SpanStatusCode.OK });
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Trace user interaction
 */
export async function traceUserInteraction<T>(
  interactionType: string,
  action: () => Promise<T>,
  attributes?: Attributes
): Promise<T> {
  const tracer = getRendererTracer();
  
  return tracer.startActiveSpan(
    `user.interaction.${interactionType}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'interaction.type': interactionType,
        ...attributes,
      },
    },
    async (span) => {
      try {
        const result = await action();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Track navigation timing
 */
export function trackNavigationTiming(): void {
  if (typeof window === 'undefined' || !window.performance) {
    return;
  }

  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  if (!navigation) {
    return;
  }

  const tracer = getRendererTracer();
  const span = tracer.startSpan('page.load', {
    kind: SpanKind.INTERNAL,
    startTime: navigation.fetchStart,
    attributes: {
      'page.url': window.location.href,
      'navigation.type': navigation.type,
    },
  });

  span.addEvent('dom_content_loaded', {
    'duration_ms': navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
  }, navigation.domContentLoadedEventStart);

  span.addEvent('load_complete', {
    'duration_ms': navigation.loadEventEnd - navigation.loadEventStart,
  }, navigation.loadEventStart);

  span.setAttributes({
    'timing.dns': navigation.domainLookupEnd - navigation.domainLookupStart,
    'timing.tcp': navigation.connectEnd - navigation.connectStart,
    'timing.request': navigation.responseStart - navigation.requestStart,
    'timing.response': navigation.responseEnd - navigation.responseStart,
    'timing.dom_interactive': navigation.domInteractive - navigation.fetchStart,
    'timing.dom_complete': navigation.domComplete - navigation.fetchStart,
    'timing.load_complete': navigation.loadEventEnd - navigation.fetchStart,
  });

  span.end(navigation.loadEventEnd);
}

/**
 * React Hook for tracing component lifecycle
 */
export function useTracing(componentName: string) {
  const tracer = getRendererTracer();

  return {
    traceEffect: (effectName: string, effect: () => void | (() => void)) => {
      const span = tracer.startSpan(`component.effect.${componentName}.${effectName}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          'component.name': componentName,
          'effect.name': effectName,
        },
      });

      try {
        const cleanup = effect();
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();

        if (typeof cleanup === 'function') {
          return () => {
            const cleanupSpan = tracer.startSpan(
              `component.effect.cleanup.${componentName}.${effectName}`,
              {
                kind: SpanKind.INTERNAL,
                attributes: {
                  'component.name': componentName,
                  'effect.name': effectName,
                },
              }
            );

            try {
              cleanup();
              cleanupSpan.setStatus({ code: SpanStatusCode.OK });
            } catch (error) {
              cleanupSpan.recordException(error as Error);
              cleanupSpan.setStatus({ code: SpanStatusCode.ERROR });
            } finally {
              cleanupSpan.end();
            }
          };
        }
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        throw error;
      }
    },

    traceAsync: async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      return tracer.startActiveSpan(
        `component.async.${componentName}.${name}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            'component.name': componentName,
            'async.name': name,
          },
        },
        async (span) => {
          try {
            const result = await fn();
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        }
      );
    },
  };
}

/**
 * Initialize web vitals tracking
 */
export function initializeWebVitals(): void {
  if (typeof window === 'undefined') {
    return;
  }

  // Track Core Web Vitals when available
  if ('PerformanceObserver' in window) {
    const tracer = getRendererTracer();

    // Largest Contentful Paint (LCP)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const span = tracer.startSpan('web_vitals.lcp', {
          kind: SpanKind.INTERNAL,
          startTime: entry.startTime,
        });
        span.setAttribute('lcp.value', entry.startTime);
        span.end(entry.startTime);
      }
    }).observe({ entryTypes: ['largest-contentful-paint'] });

    // First Input Delay (FID)
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        const span = tracer.startSpan('web_vitals.fid', {
          kind: SpanKind.INTERNAL,
          startTime: entry.startTime,
        });
        span.setAttribute('fid.value', entry.processingStart - entry.startTime);
        span.end(entry.startTime + entry.duration);
      }
    }).observe({ entryTypes: ['first-input'] });

    // Cumulative Layout Shift (CLS)
    new PerformanceObserver((list) => {
      let clsValue = 0;
      for (const entry of list.getEntries()) {
        if (!(entry as any).hadRecentInput) {
          clsValue += (entry as any).value;
        }
      }
      
      if (clsValue > 0) {
        const span = tracer.startSpan('web_vitals.cls', {
          kind: SpanKind.INTERNAL,
        });
        span.setAttribute('cls.value', clsValue);
        span.end();
      }
    }).observe({ entryTypes: ['layout-shift'] });
  }
}
