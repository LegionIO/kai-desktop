/**
 * Mastra Agent OpenTelemetry Instrumentation
 * 
 * Provides automatic tracing and metrics for Mastra agent operations
 * including tool executions, LLM calls, and workflow steps.
 */

import { trace, context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span, Attributes } from '@opentelemetry/api';
import { KaiMetrics } from './metrics';
import { traceAsync, recordException } from './tracing';

const TRACER_NAME = 'kai-mastra-agent';

/**
 * Instrument a Mastra agent instance
 */
export function instrumentMastraAgent(agent: any): any {
  if (!agent || typeof agent !== 'object') {
    return agent;
  }

  // Store original methods
  const originalGenerate = agent.generate?.bind(agent);
  const originalStream = agent.stream?.bind(agent);
  const originalExecute = agent.execute?.bind(agent);

  // Instrument generate method
  if (originalGenerate) {
    agent.generate = async function (input: any, options: any = {}) {
      return traceAsync(
        'mastra.agent.generate',
        async (span) => {
          span.setAttributes({
            'agent.name': agent.name || 'unknown',
            'agent.input.length': JSON.stringify(input).length,
            'agent.model': options.model || agent.model || 'unknown',
          });

          const startTime = Date.now();
          KaiMetrics.agentTaskStarted(agent.name, 'generate');

          try {
            const result = await originalGenerate(input, options);
            
            const duration = Date.now() - startTime;
            span.setAttributes({
              'agent.output.length': JSON.stringify(result).length,
              'agent.duration_ms': duration,
            });

            KaiMetrics.agentTaskCompleted(agent.name, 'generate', duration);
            
            return result;
          } catch (error) {
            const errorType = error instanceof Error ? error.name : 'Unknown';
            KaiMetrics.agentTaskFailed(agent.name, 'generate', errorType);
            throw error;
          }
        },
        {
          kind: SpanKind.INTERNAL,
          tracerName: TRACER_NAME,
        }
      );
    };
  }

  // Instrument stream method
  if (originalStream) {
    agent.stream = async function* (input: any, options: any = {}) {
      const tracer = trace.getTracer(TRACER_NAME);
      const span = tracer.startSpan('mastra.agent.stream', {
        kind: SpanKind.INTERNAL,
        attributes: {
          'agent.name': agent.name || 'unknown',
          'agent.input.length': JSON.stringify(input).length,
          'agent.model': options.model || agent.model || 'unknown',
        },
      });

      const startTime = Date.now();
      KaiMetrics.agentTaskStarted(agent.name, 'stream');
      let chunkCount = 0;
      let totalLength = 0;

      try {
        for await (const chunk of originalStream(input, options)) {
          chunkCount++;
          totalLength += JSON.stringify(chunk).length;
          
          span.addEvent('agent.stream.chunk', {
            'chunk.index': chunkCount,
            'chunk.length': JSON.stringify(chunk).length,
          });

          yield chunk;
        }

        const duration = Date.now() - startTime;
        span.setAttributes({
          'agent.stream.chunks': chunkCount,
          'agent.stream.total_length': totalLength,
          'agent.duration_ms': duration,
        });
        
        span.setStatus({ code: SpanStatusCode.OK });
        KaiMetrics.agentTaskCompleted(agent.name, 'stream', duration);
      } catch (error) {
        recordException(span, error);
        const errorType = error instanceof Error ? error.name : 'Unknown';
        KaiMetrics.agentTaskFailed(agent.name, 'stream', errorType);
        throw error;
      } finally {
        span.end();
      }
    };
  }

  // Instrument execute method (if present)
  if (originalExecute) {
    agent.execute = async function (input: any, options: any = {}) {
      return traceAsync(
        'mastra.agent.execute',
        async (span) => {
          span.setAttributes({
            'agent.name': agent.name || 'unknown',
            'agent.input.length': JSON.stringify(input).length,
          });

          const startTime = Date.now();
          KaiMetrics.agentTaskStarted(agent.name, 'execute');

          try {
            const result = await originalExecute(input, options);
            
            const duration = Date.now() - startTime;
            span.setAttributes({
              'agent.output.length': JSON.stringify(result).length,
              'agent.duration_ms': duration,
            });

            KaiMetrics.agentTaskCompleted(agent.name, 'execute', duration);
            
            return result;
          } catch (error) {
            const errorType = error instanceof Error ? error.name : 'Unknown';
            KaiMetrics.agentTaskFailed(agent.name, 'execute', errorType);
            throw error;
          }
        },
        {
          kind: SpanKind.INTERNAL,
          tracerName: TRACER_NAME,
        }
      );
    };
  }

  return agent;
}

/**
 * Instrument LLM client calls
 */
export function instrumentLLMClient(client: any, provider: string): any {
  if (!client || typeof client !== 'object') {
    return client;
  }

  const originalGenerate = client.generate?.bind(client);
  const originalStream = client.stream?.bind(client);

  if (originalGenerate) {
    client.generate = async function (options: any) {
      return traceAsync(
        'llm.generate',
        async (span) => {
          const model = options.model || 'unknown';
          
          span.setAttributes({
            'llm.provider': provider,
            'llm.model': model,
            'llm.prompt.length': JSON.stringify(options.prompt || options.messages).length,
            'llm.temperature': options.temperature,
            'llm.max_tokens': options.maxTokens,
          });

          const startTime = Date.now();
          KaiMetrics.llmRequestStarted(provider, model);

          try {
            const result = await originalGenerate(options);
            
            const duration = Date.now() - startTime;
            const tokenCount = result.usage?.totalTokens || 0;
            
            span.setAttributes({
              'llm.response.length': JSON.stringify(result).length,
              'llm.tokens.prompt': result.usage?.promptTokens || 0,
              'llm.tokens.completion': result.usage?.completionTokens || 0,
              'llm.tokens.total': tokenCount,
              'llm.duration_ms': duration,
            });

            KaiMetrics.llmRequestCompleted(provider, model, duration, tokenCount);
            
            return result;
          } catch (error) {
            const errorType = error instanceof Error ? error.name : 'Unknown';
            KaiMetrics.llmRequestFailed(provider, model, errorType);
            throw error;
          }
        },
        {
          kind: SpanKind.CLIENT,
          tracerName: TRACER_NAME,
          attributes: {
            'peer.service': provider,
          },
        }
      );
    };
  }

  if (originalStream) {
    client.stream = async function* (options: any) {
      const tracer = trace.getTracer(TRACER_NAME);
      const model = options.model || 'unknown';
      
      const span = tracer.startSpan('llm.stream', {
        kind: SpanKind.CLIENT,
        attributes: {
          'llm.provider': provider,
          'llm.model': model,
          'llm.prompt.length': JSON.stringify(options.prompt || options.messages).length,
          'peer.service': provider,
        },
      });

      const startTime = Date.now();
      KaiMetrics.llmRequestStarted(provider, model);
      let chunkCount = 0;

      try {
        for await (const chunk of originalStream(options)) {
          chunkCount++;
          span.addEvent('llm.stream.chunk', { 'chunk.index': chunkCount });
          yield chunk;
        }

        const duration = Date.now() - startTime;
        span.setAttributes({
          'llm.stream.chunks': chunkCount,
          'llm.duration_ms': duration,
        });
        
        span.setStatus({ code: SpanStatusCode.OK });
        KaiMetrics.llmRequestCompleted(provider, model, duration, 0); // Token count not available in streaming
      } catch (error) {
        recordException(span, error);
        const errorType = error instanceof Error ? error.name : 'Unknown';
        KaiMetrics.llmRequestFailed(provider, model, errorType);
        throw error;
      } finally {
        span.end();
      }
    };
  }

  return client;
}

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
