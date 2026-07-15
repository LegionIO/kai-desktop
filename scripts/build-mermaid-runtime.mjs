/**
 * Bundle the mermaid render runtime ONCE at build time into a self-contained
 * IIFE shipped as an app resource (resources/mermaid-runtime.js).
 *
 * Why build-time (unlike React artifacts, which esbuild at runtime): the mermaid
 * runtime is FIXED — only the diagram source varies, and that's injected as a
 * runtime string, not bundled. Bundling mermaid pulls ~58 packages / ~3.3 MB;
 * doing it at build time avoids shipping all of those as asarUnpack'd files and
 * avoids a multi-second first-render esbuild. The renderer loads this prebuilt
 * bundle (via the artifact:bundle-mermaid IPC) and runs it in the sandboxed
 * artifact iframe.
 *
 * The bundle exposes `window.__renderMermaid(source, isDark) => Promise<string>`.
 */
import esbuild from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'resources', 'mermaid-runtime.js');

const ENTRY = `
import mermaid from 'mermaid';

window.__renderMermaid = async function (source, isDark) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: isDark ? 'dark' : 'default',
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  });
  const id = 'artifact-mermaid-' + Math.random().toString(36).slice(2, 10);
  const { svg } = await mermaid.render(id, source);
  return svg;
};
`;

const result = await esbuild.build({
  stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts', sourcefile: 'mermaid-entry.ts' },
  bundle: true,
  format: 'iife',
  minify: true,
  write: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
});

const code = result.outputFiles?.[0]?.text;
if (!code) {
  console.error('[build-mermaid-runtime] esbuild produced no output');
  process.exit(1);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, code, 'utf8');
console.info(`[build-mermaid-runtime] wrote ${OUT} (${(code.length / 1024 / 1024).toFixed(2)} MB)`);
