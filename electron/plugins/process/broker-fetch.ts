import type { UtilityTransport } from './utility-transport.js';

export type BrokerFetchRequest = {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  cache: RequestCache;
  credentials: RequestCredentials;
  integrity: string;
  keepalive: boolean;
  mode: RequestMode;
  redirect: RequestRedirect;
  referrer: string;
  referrerPolicy: ReferrerPolicy;
  signal: AbortSignal;
  body?: () => AsyncGenerator<Uint8Array>;
};

export type BrokerFetchMetadata = {
  kind: 'metadata';
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  url: string;
  redirected: boolean;
  responseType: ResponseType;
  hasBody: boolean;
};

function abortedReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

/**
 * Electron's network stack lives in main, but a Node SEA has no `electron`
 * module. This adapter preserves the fetch surface by streaming request and
 * response bodies through the existing bounded callback/stream protocol.
 */
export function createBrokerFetch(transport: UtilityTransport): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestInit =
      init?.body && !('duplex' in init) ? ({ ...init, duplex: 'half' } as RequestInit & { duplex: 'half' }) : init;
    const request = new Request(input, requestInit);
    if (request.signal.aborted) throw abortedReason(request.signal);

    let body: BrokerFetchRequest['body'];
    if (request.body) {
      const reader = request.body.getReader();
      body = async function* () {
        try {
          for (;;) {
            if (request.signal.aborted) throw abortedReason(request.signal);
            const next = await reader.read();
            if (next.done) return;
            yield next.value;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // A cancelled/errored stream may already have released its reader.
          }
        }
      };
    }

    const descriptor: BrokerFetchRequest = {
      url: request.url,
      method: request.method,
      headers: [...request.headers.entries()],
      cache: request.cache,
      credentials: request.credentials,
      integrity: request.integrity,
      keepalive: request.keepalive,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
      ...(body ? { body } : {}),
    };

    const events = transport.streamCall('__fetch', [descriptor]);
    let responseController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const onAbort = (): void => {
      void events.return(undefined);
      if (responseController) {
        responseController.error(abortedReason(request.signal));
        responseController = null;
      }
    };
    request.signal.addEventListener('abort', onAbort, { once: true });

    let first: IteratorResult<unknown>;
    try {
      first = await events.next();
    } catch (error) {
      request.signal.removeEventListener('abort', onAbort);
      if (request.signal.aborted) throw abortedReason(request.signal);
      throw error;
    }
    if (first.done || !first.value || typeof first.value !== 'object') {
      request.signal.removeEventListener('abort', onAbort);
      if (request.signal.aborted) throw abortedReason(request.signal);
      throw new TypeError('Plugin fetch broker ended before returning response headers');
    }
    const metadata = first.value as BrokerFetchMetadata;
    if (metadata.kind !== 'metadata') {
      request.signal.removeEventListener('abort', onAbort);
      await events.return(undefined);
      throw new TypeError('Plugin fetch broker returned an invalid response');
    }

    const responseBody = metadata.hasBody
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            responseController = controller;
            if (request.signal.aborted) onAbort();
          },
          async pull(controller) {
            try {
              const next = await events.next();
              if (request.signal.aborted) return;
              if (next.done) {
                request.signal.removeEventListener('abort', onAbort);
                responseController = null;
                controller.close();
                return;
              }
              const chunk = next.value;
              if (!(chunk instanceof Uint8Array)) throw new TypeError('Plugin fetch broker returned a non-byte chunk');
              controller.enqueue(chunk);
            } catch (error) {
              request.signal.removeEventListener('abort', onAbort);
              if (!request.signal.aborted) controller.error(error);
              responseController = null;
            }
          },
          async cancel() {
            request.signal.removeEventListener('abort', onAbort);
            responseController = null;
            await events.return(undefined);
          },
        })
      : null;

    if (!metadata.hasBody) {
      request.signal.removeEventListener('abort', onAbort);
      await events.return(undefined);
    }
    const response = new Response(responseBody, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
    // Response's constructor cannot set these fetch-populated readonly fields.
    // Own properties preserve the observable contract for existing plugins.
    Object.defineProperties(response, {
      url: { value: metadata.url, enumerable: true },
      redirected: { value: metadata.redirected, enumerable: true },
      type: { value: metadata.responseType, enumerable: true },
    });
    return response;
  }) as typeof globalThis.fetch;
}
