/**
 * OpenTelemetry Metrics Utilities
 * 
 * Provides helper functions for recording metrics including
 * counters, histograms, gauges, and up-down counters.
 */

import { metrics, ValueType } from '@opentelemetry/api';
import type {
  Counter,
  Histogram,
  UpDownCounter,
  ObservableGauge,
  MetricOptions,
  Attributes,
} from '@opentelemetry/api';

const DEFAULT_METER_NAME = 'kai-desktop';

/**
 * Get a meter instance
 */
export function getMeter(name: string = DEFAULT_METER_NAME) {
  return metrics.getMeter(name);
}

/**
 * Metric Registry - stores created metrics for reuse
 */
class MetricRegistry {
  private counters = new Map<string, Counter>();
  private histograms = new Map<string, Histogram>();
  private upDownCounters = new Map<string, UpDownCounter>();
  private gauges = new Map<string, ObservableGauge>();

  getOrCreateCounter(name: string, options?: MetricOptions): Counter {
    if (!this.counters.has(name)) {
      const meter = getMeter();
      this.counters.set(name, meter.createCounter(name, options));
    }
    return this.counters.get(name)!;
  }

  getOrCreateHistogram(name: string, options?: MetricOptions): Histogram {
    if (!this.histograms.has(name)) {
      const meter = getMeter();
      this.histograms.set(name, meter.createHistogram(name, options));
    }
    return this.histograms.get(name)!;
  }

  getOrCreateUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    if (!this.upDownCounters.has(name)) {
      const meter = getMeter();
      this.upDownCounters.set(name, meter.createUpDownCounter(name, options));
    }
    return this.upDownCounters.get(name)!;
  }

  createObservableGauge(
    name: string,
    callback: (observableResult: any) => void,
    options?: MetricOptions
  ): ObservableGauge {
    const meter = getMeter();
    const gauge = meter.createObservableGauge(name, options);
    gauge.addCallback(callback);
    this.gauges.set(name, gauge);
    return gauge;
  }
}

const registry = new MetricRegistry();

/**
 * Increment a counter metric
 */
export function incrementCounter(
  name: string,
  value: number = 1,
  attributes?: Attributes
): void {
  const counter = registry.getOrCreateCounter(name, {
    description: `Counter for ${name}`,
    valueType: ValueType.INT,
  });
  counter.add(value, attributes);
}

/**
 * Record a histogram value (for distributions)
 */
export function recordHistogram(
  name: string,
  value: number,
  attributes?: Attributes
): void {
  const histogram = registry.getOrCreateHistogram(name, {
    description: `Histogram for ${name}`,
    valueType: ValueType.DOUBLE,
  });
  histogram.record(value, attributes);
}

/**
 * Record an up-down counter (can increase or decrease)
 */
export function recordUpDownCounter(
  name: string,
  value: number,
  attributes?: Attributes
): void {
  const upDownCounter = registry.getOrCreateUpDownCounter(name, {
    description: `Up-down counter for ${name}`,
    valueType: ValueType.INT,
  });
  upDownCounter.add(value, attributes);
}

/**
 * Create an observable gauge (async callback-based metric)
 */
export function createGauge(
  name: string,
  callback: () => number | Promise<number>,
  options?: MetricOptions
): ObservableGauge {
  return registry.createObservableGauge(
    name,
    async (observableResult) => {
      const value = await callback();
      observableResult.observe(value);
    },
    {
      description: `Gauge for ${name}`,
      valueType: ValueType.DOUBLE,
      ...options,
    }
  );
}

/**
 * High-level metrics for common Kai Desktop operations
 */
export const KaiMetrics = {
  // Agent metrics
  agentTaskStarted: (agentName: string, taskType: string) => {
    incrementCounter('kai.agent.task.started', 1, {
      'agent.name': agentName,
      'task.type': taskType,
    });
  },

  agentTaskCompleted: (agentName: string, taskType: string, durationMs: number) => {
    incrementCounter('kai.agent.task.completed', 1, {
      'agent.name': agentName,
      'task.type': taskType,
    });
    recordHistogram('kai.agent.task.duration', durationMs, {
      'agent.name': agentName,
      'task.type': taskType,
    });
  },

  agentTaskFailed: (agentName: string, taskType: string, errorType: string) => {
    incrementCounter('kai.agent.task.failed', 1, {
      'agent.name': agentName,
      'task.type': taskType,
      'error.type': errorType,
    });
  },

  // LLM metrics
  llmRequestStarted: (provider: string, model: string) => {
    incrementCounter('kai.llm.request.started', 1, {
      'llm.provider': provider,
      'llm.model': model,
    });
  },

  llmRequestCompleted: (
    provider: string,
    model: string,
    durationMs: number,
    tokenCount: number
  ) => {
    incrementCounter('kai.llm.request.completed', 1, {
      'llm.provider': provider,
      'llm.model': model,
    });
    recordHistogram('kai.llm.request.duration', durationMs, {
      'llm.provider': provider,
      'llm.model': model,
    });
    recordHistogram('kai.llm.tokens.total', tokenCount, {
      'llm.provider': provider,
      'llm.model': model,
    });
  },

  llmRequestFailed: (provider: string, model: string, errorType: string) => {
    incrementCounter('kai.llm.request.failed', 1, {
      'llm.provider': provider,
      'llm.model': model,
      'error.type': errorType,
    });
  },

  // Tool usage metrics
  toolExecuted: (toolName: string, durationMs: number, success: boolean) => {
    incrementCounter('kai.tool.executed', 1, {
      'tool.name': toolName,
      'tool.success': success,
    });
    recordHistogram('kai.tool.duration', durationMs, {
      'tool.name': toolName,
    });
  },

  // UI metrics
  conversationStarted: (conversationType: string) => {
    incrementCounter('kai.conversation.started', 1, {
      'conversation.type': conversationType,
    });
  },

  conversationMessageSent: (role: string, messageLength: number) => {
    incrementCounter('kai.conversation.message.sent', 1, {
      'message.role': role,
    });
    recordHistogram('kai.conversation.message.length', messageLength, {
      'message.role': role,
    });
  },

  // System metrics
  memoryUsage: (heapUsed: number, heapTotal: number, external: number) => {
    recordHistogram('kai.system.memory.heap_used', heapUsed);
    recordHistogram('kai.system.memory.heap_total', heapTotal);
    recordHistogram('kai.system.memory.external', external);
  },

  activeConnections: (count: number) => {
    recordUpDownCounter('kai.system.connections.active', count);
  },
};

/**
 * Start periodic system metrics collection
 */
export function startSystemMetricsCollection(intervalMs: number = 60000): NodeJS.Timeout {
  return setInterval(() => {
    const memUsage = process.memoryUsage();
    KaiMetrics.memoryUsage(
      memUsage.heapUsed,
      memUsage.heapTotal,
      memUsage.external
    );
  }, intervalMs);
}
