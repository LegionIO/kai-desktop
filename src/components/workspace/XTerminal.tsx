import { useEffect, useRef, useCallback, type FC } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { app } from '@/lib/ipc-client';
import 'xterm/css/xterm.css';

const TERMINAL_THEME = {
  background: '#0a0a0a',
  foreground: '#e0e0e0',
  cursor: '#06b6d4',
  cursorAccent: '#0a0a0a',
  selectionBackground: '#06b6d430',
  black: '#1a1a1a',
  red: '#ef4444',
  green: '#10b981',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#8b5cf6',
  cyan: '#06b6d4',
  white: '#e0e0e0',
  brightBlack: '#525252',
  brightRed: '#f87171',
  brightGreen: '#34d399',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#a78bfa',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
};

interface XTerminalProps {
  sessionId: string;
  cwd: string;
  /** If true, the PTY session was already created externally — just attach to it. */
  preSpawned?: boolean;
  onExit?: (exitCode: number) => void;
}

export const XTerminal: FC<XTerminalProps> = ({ sessionId, cwd, preSpawned, onExit }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const mountedRef = useRef(false);

  // Stable resize handler
  const handleResize = useCallback(() => {
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      // ignore — can happen if terminal is not yet attached
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current || mountedRef.current) return;
    mountedRef.current = true;

    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontFamily: "'JetBrains Mono', 'Menlo', 'Monaco', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    termRef.current = term;
    fitRef.current = fitAddon;

    // Open terminal in the DOM
    term.open(containerRef.current);

    // Initial fit (deferred to let the DOM settle)
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch { /* ignore */ }
    });

    // Spawn or attach to the PTY process in the main process
    const cols = term.cols;
    const rows = term.rows;

    let cleanupData: (() => void) | null = null;
    let cleanupExit: (() => void) | null = null;

    const attachToPty = () => {
      // Subscribe to data from the PTY
      cleanupData = app.pty.onData((id, data) => {
        if (id === sessionId) {
          term.write(data);
        }
      });

      // Subscribe to PTY exit
      cleanupExit = app.pty.onExit((id, exitCode) => {
        if (id === sessionId) {
          term.write(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`);
          onExit?.(exitCode);
        }
      });
    };

    if (preSpawned) {
      // PTY already created externally — attach listeners first, then drain buffered output
      attachToPty();
      app.pty.resize(sessionId, cols, rows).catch(() => { /* ignore */ });
      // Drain any output that occurred before we attached
      app.pty.drain(sessionId).then(({ data }) => {
        if (data) {
          term.write(data);
        }
      }).catch(() => { /* ignore */ });
    } else {
      app.pty.create(sessionId, cwd, cols, rows).then(() => {
        attachToPty();
      }).catch((err) => {
        term.write(`\x1b[31mFailed to create PTY session: ${err}\x1b[0m\r\n`);
      });
    }

    // Forward user input to the PTY
    const inputDisposable = term.onData((data) => {
      app.pty.write(sessionId, data);
    });

    // Resize PTY when terminal is resized
    const resizeDisposable = term.onResize(({ cols: newCols, rows: newRows }) => {
      app.pty.resize(sessionId, newCols, newRows);
    });

    // Listen for window resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try { fitAddon.fit(); } catch { /* ignore */ }
      });
    });
    resizeObserver.observe(containerRef.current);

    // Cleanup on unmount
    return () => {
      mountedRef.current = false;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      cleanupData?.();
      cleanupExit?.();
      // Only destroy PTY on unmount if we created it (not pre-spawned by task execution)
      if (!preSpawned) {
        app.pty.destroy(sessionId).catch(() => { /* ignore */ });
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, cwd, preSpawned, onExit, handleResize]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ minHeight: 0 }}
    />
  );
};
