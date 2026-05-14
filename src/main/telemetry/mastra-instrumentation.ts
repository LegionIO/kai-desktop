/**
 * Mastra Agent OpenTelemetry Instrumentation
 *
 * Provides safe, standalone tracing helpers for Mastra operations.
 * Does NOT monkey-patch agent or LLM client objects — use @mastra/core's
 * built-in OTel telemetry hooks for agent-level tracing.
 */

import { trace, SpanKind } from '@opentelemetry/api';
import type { Span, Attributes } from '@opentelemetry/api';
import { KaiMetrics } from './metrics';
import { traceAsync } from './tracing';

const TRACER_NAME = 'kai-mastra-agent';

/**
 * Instrument tool execution
 */
export async function instrumentToolExecution<T>(
  toolName: string,
  execute: () => Promise<T>
): Promise<T> {
  return traceAsync(
    'tool.execute',
    async (span) => {
      span.setAttributes({
        'tool.name': toolName,
      });

      const startTime = Date.now();

      try {
        const result = await execute();
        const duration = Date.now() - startTime;
        
        span.setAttributes({
          'tool.duration_ms': duration,
          'tool.success': true,
        });

        KaiMetrics.toolExecuted(toolName, duration, true);
        
        return result;
      } catch (error) {
        const duration = Date.now() - startTime;
        KaiMetrics.toolExecuted(toolName, duration, false);
        throw error;
      }
    },
    {
      kind: SpanKind.INTERNAL,
      tracerName: TRACER_NAME,
    }
  );
}

/**
 * Create workflow step span
 */
export function createWorkflowStepSpan(
  workflowName: string,
  stepName: string,
  attributes?: Attributes
): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  
  return tracer.startSpan(`workflow.step.${stepName}`, {
    kind: SpanKind.INTERNAL,
    attributes: {
      'workflow.name': workflowName,
      'workflow.step': stepName,
      ...attributes,
    },
  });
}
