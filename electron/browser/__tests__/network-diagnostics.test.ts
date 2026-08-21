import { describe, expect, it } from 'vitest';
import {
  boundedNetworkMethod,
  browserLoadTimingFromNetworkRequests,
  browserNetworkPageIdentity,
  createBrowserNetworkRedactionKey,
  normalizeBrowserLoadTiming,
  responseContentLength,
  sanitizeBrowserNetworkError,
  sanitizeBrowserNetworkUrl,
  snapshotBrowserNetworkRequests,
} from '../network-diagnostics.js';

describe('Browser network diagnostics', () => {
  it('removes credentials, query strings, fragments, and potentially secret path segments', () => {
    const redactionKey = createBrowserNetworkRedactionKey();
    const result = sanitizeBrowserNetworkUrl(
      'https://alice:password@example.com/api/orders/123?access_token=secret#account',
      redactionKey,
    );

    expect(result).toEqual({
      url: expect.stringMatching(/^\[redacted https origin [a-f0-9]{16}\]\/\[redacted-path\]$/),
      redacted: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|password|access_token|secret|account|orders|123|example\.com/);
  });

  it('uses stable opaque origin tokens instead of exposing secret-bearing host labels', () => {
    const redactionKey = createBrowserNetworkRedactionKey();
    const first = sanitizeBrowserNetworkUrl('https://otp-123456.account.attacker.example/', redactionKey);
    const second = sanitizeBrowserNetworkUrl('https://otp-123456.account.attacker.example/api', redactionKey);
    const other = sanitizeBrowserNetworkUrl('https://different.attacker.example/', redactionKey);
    const page = browserNetworkPageIdentity('https://otp-123456.account.attacker.example/dashboard', redactionKey);

    const firstToken = first.url.match(/origin ([a-f0-9]{16})/)?.[1];
    expect(firstToken).toBeTruthy();
    expect(second.url).toContain(`origin ${firstToken}`);
    expect(page).toContain(`origin ${firstToken}`);
    expect(other.url).not.toContain(`origin ${firstToken}`);
    expect(JSON.stringify({ first, second, other, page })).not.toMatch(/otp|123456|account|attacker|different/);
  });

  it('does not make origin tokens comparable across tabs or documents', () => {
    const firstDocument = createBrowserNetworkRedactionKey();
    const secondDocument = createBrowserNetworkRedactionKey();
    const url = 'https://private-hostname.example/';

    expect(sanitizeBrowserNetworkUrl(url, firstDocument).url).not.toBe(
      sanitizeBrowserNetworkUrl(url, secondDocument).url,
    );
  });

  it('returns bounded request metadata without headers, bodies, or raw errors', () => {
    const redactionKey = createBrowserNetworkRedactionKey();
    const snapshot = snapshotBrowserNetworkRequests(
      [
        {
          id: 1,
          sequence: 1,
          url: 'https://api.example.test/data?token=secret',
          method: 'post',
          resourceType: 'xhr',
          startedAt: 1_000,
          completedAt: 1_125,
          statusCode: 503,
          fromCache: false,
          responseBytes: 42,
          error: 'net::ERR_FAILED at https://api.example.test/data?token=secret',
        },
      ],
      10,
      redactionKey,
      2_000,
    );

    expect(snapshot).toMatchObject({ requestCount: 1, inFlight: 0, truncated: false });
    expect(snapshot.entries[0]).toMatchObject({
      url: expect.stringMatching(/^\[redacted https origin [a-f0-9]{16}\]\/\[redacted-path\]$/),
      urlRedacted: true,
      method: 'POST',
      resourceType: 'xhr',
      statusCode: 503,
      responseBytes: 42,
      durationMs: 125,
      pending: false,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/token=secret|api\.example\.test/);
  });

  it('does not expose page-controlled custom methods through diagnostics', () => {
    expect(boundedNetworkMethod('get')).toBe('GET');
    expect(boundedNetworkMethod('PATCH')).toBe('PATCH');
    expect(boundedNetworkMethod('SECRETACCOUNTSTATE')).toBe('OTHER');
  });

  it('normalizes only finite load metrics and parses content length without exposing headers', () => {
    expect(
      normalizeBrowserLoadTiming({
        navigationType: 'reload',
        timeToFirstByteMs: 12.345,
        domContentLoadedMs: 45.678,
        loadEventMs: Number.NaN,
        decodedBodySizeBytes: -1,
      }),
    ).toEqual({
      navigationType: 'reload',
      timeToFirstByteMs: 12.35,
      domContentLoadedMs: 45.68,
    });
    expect(responseContentLength({ 'Content-Length': ['1234'], 'Set-Cookie': ['secret=value'] })).toBe(1234);
    expect(sanitizeBrowserNetworkError('net::ERR_FAILED at https://secret.example.test/')).toBe('net::ERR_FAILED');
    expect(sanitizeBrowserNetworkError('https://attacker.test/?reason=net::ERR_ACCOUNT_SECRET')).toBe(
      'Network request failed.',
    );
    expect(sanitizeBrowserNetworkError('Request failed for https://attacker.test/ERR_PASSWORD_TOKEN')).toBe(
      'Network request failed.',
    );
    expect(sanitizeBrowserNetworkError(new Error('net::ERR_NAME_NOT_RESOLVED at https://secret.example.test/'))).toBe(
      'net::ERR_NAME_NOT_RESOLVED',
    );
    expect(sanitizeBrowserNetworkError('ERR_NAME_NOT_RESOLVED at https://attacker.test/')).toBe(
      'Network request failed.',
    );
  });

  it('derives load timing only from manager-owned main-frame request events', () => {
    expect(
      browserLoadTimingFromNetworkRequests([
        {
          id: 1,
          sequence: 1,
          url: '[redacted https origin 0000000000000000]',
          method: 'GET',
          resourceType: 'mainFrame',
          startedAt: 1_000,
          responseStartedAt: 1_024.567,
          completedAt: 1_080.111,
        },
        {
          id: 2,
          sequence: 2,
          url: '[redacted https origin 0000000000000000]/[redacted-path]',
          method: 'GET',
          resourceType: 'xhr',
          startedAt: 1_010,
          completedAt: 1_020,
        },
      ]),
    ).toEqual({
      navigationType: 'unknown',
      timeToFirstByteMs: 24.57,
      responseEndMs: 80.11,
      durationMs: 80.11,
    });
  });
});
