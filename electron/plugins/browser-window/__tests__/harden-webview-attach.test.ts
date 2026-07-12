/**
 * Tests for hardenWebviewAttach — the will-attach-webview chokepoint that forces
 * safe guest webPreferences on every <webview> the in-app browser chrome attaches
 * (it renders untrusted web pages). A guest must never get Node integration or an
 * attacker-controllable preload, regardless of what the tag attributes request.
 */
import { describe, it, expect } from 'vitest';
import { hardenWebviewAttach } from '../index.js';

describe('hardenWebviewAttach', () => {
  it('forces safe webPreferences even when the tag asked for dangerous ones', () => {
    const webPreferences: Record<string, unknown> = {
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: '/evil/preload.js',
    };
    hardenWebviewAttach(webPreferences, {});
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false);
    expect(webPreferences.nodeIntegrationInWorker).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(webPreferences.webSecurity).toBe(true);
    expect('preload' in webPreferences).toBe(false);
  });

  it('strips Node/preload-enabling tag attributes from params', () => {
    const params: Record<string, unknown> = {
      src: 'https://evil.example',
      nodeintegration: '',
      nodeintegrationinsubframes: '',
      preload: 'file:///evil.js',
      webpreferences: 'nodeIntegration=yes,contextIsolation=no',
      partition: 'persist:browser',
    };
    hardenWebviewAttach({}, params);
    expect('nodeintegration' in params).toBe(false);
    expect('nodeintegrationinsubframes' in params).toBe(false);
    expect('preload' in params).toBe(false);
    expect('webpreferences' in params).toBe(false);
    // Legitimate attributes are preserved.
    expect(params.src).toBe('https://evil.example');
    expect(params.partition).toBe('persist:browser');
  });

  it('is a no-op-safe on already-clean inputs', () => {
    const webPreferences: Record<string, unknown> = {};
    const params: Record<string, unknown> = { src: 'https://ok.example' };
    hardenWebviewAttach(webPreferences, params);
    expect(webPreferences.nodeIntegration).toBe(false);
    expect(webPreferences.contextIsolation).toBe(true);
    expect(webPreferences.sandbox).toBe(true);
    expect(params.src).toBe('https://ok.example');
  });
});
