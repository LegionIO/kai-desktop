/**
 * OpenTelemetry Tracing Utilities
 * 
 * Provides helper functions for creating and managing spans,
 * custom instrumentation, and error tracking.
 */

import { trace, context, Span, SpanStatusCode, SpanKind, Tracer } from '@opentelemetry/api';
import type { Attributes, AttributeValue } from '@opentelemetry/api';

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

/**
 * Decorator for tracing class methods
 */
export function Trace(spanName?: string) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;
    const name = spanName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: any[]) {
      return traceAsync(
        name,
        async (span) => {
          span.setAttribute('method', propertyKey);
          span.setAttribute('class', target.constructor.name);
          return originalMethod.apply(this, args);
        },
        { tracerName: target.constructor.name }
      );
    };

    return descriptor;
  };
}

/**
 * Create a span link to another trace
 */
export function createSpanLink(traceId: string, spanId: string) {
  return {
    context: {
      traceId,
      spanId,
      traceFlags: 1,
    },
  };
}

/**
 * Extract trace context from carrier (e.g., HTTP headers)
 */
export function extractContext(carrier: Record<string, string>): any {
  // This would use W3C Trace Context propagation
  return context.active();
}

/**
 * Inject trace context into carrier (e.g., HTTP headers)
 */
export function injectContext(carrier: Record<string, string>): void {
  // This would use W3C Trace Context propagation
  const span = trace.getActiveSpan();
  if (span) {
    const spanContext = span.spanContext();
    carrier['traceparent'] = `00-${spanContext.traceId}-${spanContext.spanId}-01`;
  }
}
