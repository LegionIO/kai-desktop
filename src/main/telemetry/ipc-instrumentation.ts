/**
 * Electron IPC OpenTelemetry Instrumentation
 * 
 * Instruments Electron IPC communication between main and renderer processes
 * with distributed tracing support.
 */

import { ipcMain, ipcRenderer } from 'electron';
import { trace, context, propagation, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { traceAsync, recordException } from './tracing';

const TRACER_NAME = 'kai-ipc';
const propagator = new W3CTraceContextPropagator();

/**
 * Wrap IPC message with trace context
 */
interface TracedIPCMessage {
  data: any;
  traceContext?: Record<string, string>;
}

/**
 * Instrument IPC Main (main process side)
 */
export function instrumentIPCMain() {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalOn = ipcMain.on.bind(ipcMain);

  // Instrument ipcMain.handle
  ipcMain.handle = function (channel: string, listener: Function) {
    const wrappedListener = async (event: any, ...args: any[]) => {
      const tracer = trace.getTracer(TRACER_NAME);
      
      // Extract trace context from first argument if present
      let parentContext = context.active();
      const firstArg = args[0];
      
      if (firstArg && typeof firstArg === 'object' && firstArg.traceContext) {
        const carrier = firstArg.traceContext;
        parentContext = propagation.extract(context.active(), carrier);
        // Remove trace context from args
        args[0] = firstArg.data;
      }

      return context.with(parentContext, () => {
        return traceAsync(
          `ipc.handle.${channel}`,
          async (span) => {
            span.setAttributes({
              'ipc.channel': channel,
              'ipc.direction': 'renderer_to_main',
              'ipc.type': 'handle',
              'ipc.args.count': args.length,
            });

            try {
              const result = await listener(event, ...args);
              
              span.setAttributes({
                'ipc.result.type': typeof result,
              });
              
              return result;
            } catch (error) {
              recordException(span, error);
              throw error;
            }
          },
          {
            kind: SpanKind.SERVER,
            tracerName: TRACER_NAME,
          }
        );
      });
    };

    return originalHandle(channel, wrappedListener);
  };

  // Instrument ipcMain.on
  ipcMain.on = function (channel: string, listener: Function) {
    const wrappedListener = (event: any, ...args: any[]) => {
      const tracer = trace.getTracer(TRACER_NAME);
      
      // Extract trace context
      let parentContext = context.active();
      const firstArg = args[0];
      
      if (firstArg && typeof firstArg === 'object' && firstArg.traceContext) {
        const carrier = firstArg.traceContext;
        parentContext = propagation.extract(context.active(), carrier);
        args[0] = firstArg.data;
      }

      context.with(parentContext, () => {
        const span = tracer.startSpan(
          `ipc.on.${channel}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'ipc.channel': channel,
              'ipc.direction': 'renderer_to_main',
              'ipc.type': 'on',
              'ipc.args.count': args.length,
            },
          }
        );

        try {
          listener(event, ...args);
          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          recordException(span, error);
        } finally {
          span.end();
        }
      });
    };

    return originalOn(channel, wrappedListener);
  };

  console.log('[Telemetry] IPC Main instrumented');
}

/**
 * Instrument IPC Renderer (renderer process side)
 */
export function instrumentIPCRenderer() {
  if (!ipcRenderer) {
    console.warn('[Telemetry] ipcRenderer not available in this context');
    return;
  }

  const originalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
  const originalSend = ipcRenderer.send.bind(ipcRenderer);

  // Instrument ipcRenderer.invoke
  ipcRenderer.invoke = async function (channel: string, ...args: any[]) {
    return traceAsync(
      `ipc.invoke.${channel}`,
      async (span) => {
        span.setAttributes({
          'ipc.channel': channel,
          'ipc.direction': 'main_to_renderer',
          'ipc.type': 'invoke',
          'ipc.args.count': args.length,
        });

        // Inject trace context into first argument
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        
        const tracedMessage: TracedIPCMessage = {
          data: args[0],
          traceContext: carrier,
        };

        try {
          const result = await originalInvoke(channel, tracedMessage, ...args.slice(1));
          
          span.setAttributes({
            'ipc.result.type': typeof result,
          });
          
          return result;
        } catch (error) {
          recordException(span, error);
          throw error;
        }
      },
      {
        kind: SpanKind.CLIENT,
        tracerName: TRACER_NAME,
      }
    );
  };

  // Instrument ipcRenderer.send
  ipcRenderer.send = function (channel: string, ...args: any[]) {
    const tracer = trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(
      `ipc.send.${channel}`,
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'ipc.channel': channel,
          'ipc.direction': 'main_to_renderer',
          'ipc.type': 'send',
          'ipc.args.count': args.length,
        },
      }
    );

    try {
      // Inject trace context
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);
      
      const tracedMessage: TracedIPCMessage = {
        data: args[0],
        traceContext: carrier,
      };

      originalSend(channel, tracedMessage, ...args.slice(1));
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      recordException(span, error);
    } finally {
      span.end();
    }
  };

  console.log('[Telemetry] IPC Renderer instrumented');
}

/**
 * Create a traced IPC call helper
 */
export async function tracedIPCInvoke<T>(
  channel: string,
  ...args: any[]
): Promise<T> {
  if (typeof ipcRenderer === 'undefined') {
    throw new Error('ipcRenderer not available');
  }

  return ipcRenderer.invoke(channel, ...args);
}

/**
 * Send a traced IPC message
 */
export function tracedIPCSend(channel: string, ...args: any[]): void {
  if (typeof ipcRenderer === 'undefined') {
    throw new Error('ipcRenderer not available');
  }

  ipcRenderer.send(channel, ...args);
}
