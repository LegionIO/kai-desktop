/**
 * useTaskTerminal — manages an xterm.js instance connected to a PTY
 * session in the main process via IPC.
 *
 * Adapted from Aperant's useXterm + usePtyProcess hooks, simplified
 * for Kai's single-terminal-per-task model.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { app } from '@/lib/ipc-client';

import '@xterm/xterm/css/xterm.css';

interface UseTaskTerminalOptions {
  sessionId: string | null;
  /** Called when the PTY process exits. */
  onExit?: (exitCode: number) => void;
}

export function useTaskTerminal({ sessionId, onExit }: UseTaskTerminalOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // ── Initialize xterm instance ─────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      lineHeight: 1.2,
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#44475a',
      },
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());
    xterm.open(containerRef.current);

    // Delay fit so the container has had time to lay out
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {
        // may fail if container not visible yet
      }
    });

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    return () => {
      xterm.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  // ── Wire up IPC data streaming ────────────────────────────────────

  useEffect(() => {
    if (!sessionId) return;

    // Replay historical output first (restores content after navigate away/back)
    app.tasks.terminalHistory(sessionId).then((history) => {
      if (history?.length && xtermRef.current) {
        for (const line of history) {
          xtermRef.current.write(line);
        }
      }
    }).catch(() => {});

    // Receive data from PTY
    const unsubData = app.tasks.onTerminalData((event) => {
      if (event.sessionId === sessionId) {
        xtermRef.current?.write(event.data);
      }
    });

    // Handle PTY exit
    const unsubExit = app.tasks.onTerminalExit((event) => {
      if (event.sessionId === sessionId) {
        xtermRef.current?.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
        onExit?.(event.exitCode);
      }
    });

    // Send user input to PTY
    const disposable = xtermRef.current?.onData((data) => {
      void app.tasks.terminalWrite(sessionId, data);
    });

    return () => {
      unsubData();
      unsubExit();
      disposable?.dispose();
    };
  }, [sessionId, onExit]);

  // ── Handle resize ─────────────────────────────────────────────────

  useEffect(() => {
    if (!sessionId || !containerRef.current) return;

    const ro = new ResizeObserver(() => {
      try {
        fitAddonRef.current?.fit();
        const dims = fitAddonRef.current?.proposeDimensions();
        if (dims) {
          void app.tasks.terminalResize(sessionId, dims.cols, dims.rows);
        }
      } catch {
        // ignore resize errors
      }
    });

    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [sessionId]);

  // ── Imperative API ────────────────────────────────────────────────

  const focus = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const fit = useCallback(() => {
    try {
      fitAddonRef.current?.fit();
    } catch {
      // ignore
    }
  }, []);

  return { containerRef, xtermRef, fitAddonRef, focus, fit };
}
