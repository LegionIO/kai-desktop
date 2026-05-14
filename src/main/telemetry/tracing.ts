/**
 * OpenTelemetry Tracing Utilities
 * 
 * Provides helper functions for creating and managing spans,
 * custom instrumentation, and error tracking.
 */

import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import type { Span, Tracer, Attributes, AttributeValue } from '@opentelemetry/api';

const DEFAULT_TRACER_NAME = 'kai-desktop';

/**
 * Get a tracer instance
 */
export function getTracer(name: string = DEFAULT_TRACER_NAME): Tracer {
  return trace.getTracer(name);
}

/**
 * Create and execute a traced operation
 */
export async function traceAsync<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  options?: {
    attributes?: Attributes;
    kind?: SpanKind;
    tracerName?: string;
  }
): Promise<T> {
  const tracer = getTracer(options?.tracerName);
  
  return tracer.startActiveSpan(
    name,
    {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: options?.attributes,
    },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordException(span, error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Create and execute a traced synchronous operation
 */
export function traceSync<T>(
  name: string,
  fn: (span: Span) => T,
  options?: {
    attributes?: Attributes;
    kind?: SpanKind;
    tracerName?: string;
  }
): T {
  const tracer = getTracer(options?.tracerName);
  
  return tracer.startActiveSpan(
    name,
    {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: options?.attributes,
    },
    (span) => {
      try {
        const result = fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        recordException(span, error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Record an exception on a span with full error details
 */
export function recordException(span: Span, error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));
  
  span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err.message,
  });
  
  // Add error attributes
  span.setAttributes({
    'error.type': err.name,
    'error.message': err.message,
    'error.stack': err.stack || '',
  });
}

/**
 * Add event to current active span
 */
export function addEvent(name: string, attributes?: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Set attribute on current active span
 */
export function setAttribute(key: string, value: AttributeValue): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute(key, value);
  }
}

/**
 * Set multiple attributes on current active span
 */
export function setAttributes(attributes: Attributes): void {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttributes(attributes);
  }
}

/**
 * Get the current active span
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

