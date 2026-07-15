import { describe, expect, it, vi } from 'vitest';

// bundleReact resolves react/react-dom from app.getAppPath()/node_modules — in
// the test env that's the repo root (where React is a real dependency), so the
// resolve-and-validate path succeeds for React and rejects everything else.
vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }));

import { artifactBindsReact, __internal } from '../artifact-bundle.js';

const { bundleReact, bundleMermaidRuntime } = __internal;

describe('artifactBindsReact', () => {
  it('detects a default import', () => {
    expect(artifactBindsReact("import React from 'react';")).toBe(true);
    expect(artifactBindsReact("import React, { useState } from 'react';")).toBe(true);
  });

  it('detects a namespace import', () => {
    expect(artifactBindsReact("import * as React from 'react';")).toBe(true);
  });

  it('detects a named React import (incl. alias)', () => {
    expect(artifactBindsReact("import { React } from 'react';")).toBe(true);
    expect(artifactBindsReact("import { Something as React } from 'react';")).toBe(true);
  });

  it('does NOT treat a named-only import as a React binding', () => {
    // The bug: this must return false so the `import * as React` alias is
    // injected — otherwise `React.createElement` fails with "React is not defined".
    expect(artifactBindsReact("import { useState } from 'react';")).toBe(false);
    expect(artifactBindsReact("import { useState, useEffect } from 'react';")).toBe(false);
  });

  it('does not false-positive on identifiers that merely contain React', () => {
    expect(artifactBindsReact("import { useReactThing } from 'react';")).toBe(false);
    expect(artifactBindsReact("import { ReactDOMServer } from 'react';")).toBe(false);
  });

  it('returns false when react is not imported at all', () => {
    expect(artifactBindsReact('const x = 1;')).toBe(false);
    expect(artifactBindsReact("import { foo } from 'other';")).toBe(false);
  });

  it('handles double-quoted and single-quoted specifiers', () => {
    expect(artifactBindsReact('import React from "react";')).toBe(true);
  });

  it('returns quickly on a pathological input (no quadratic backtracking)', () => {
    // Many long import-like lines that never resolve to `from 'react'` would
    // catastrophically backtrack the old single multiline regex. Bounded now.
    const evil = (`import ${'x'.repeat(3000)} `.repeat(1) + '\n').repeat(2000); // ~6MB of import-ish lines
    const t0 = Date.now();
    expect(artifactBindsReact(evil)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('still detects react binding mixed into a large non-matching source', () => {
    const big = "import { foo } from 'other';\n".repeat(5000) + "import React from 'react';\n";
    expect(artifactBindsReact(big)).toBe(true);
  });
});

describe('bundleReact import allowlist (end-to-end esbuild)', () => {
  it('bundles a real React artifact (react resolves + validates under node_modules)', async () => {
    const res = await bundleReact('export default function App(){ return <div>hi</div>; }');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.code.length).toBeGreaterThan(0);
  });

  it('rejects a non-allowlisted bare package import', async () => {
    // The import must be USED — esbuild tree-shakes an unused import before it
    // ever reaches the resolver (so an unused import is harmless anyway).
    const res = await bundleReact("import fs from 'fs'; export default () => fs.readFileSync('x');");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not allowed/i);
  });

  it('rejects a relative import (arbitrary local file)', async () => {
    const res = await bundleReact("import x from '../../secret'; export default () => x;");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not allowed/i);
  });

  it('rejects an absolute-path import', async () => {
    const res = await bundleReact("import x from '/etc/passwd'; export default () => x;");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not allowed/i);
  });

  it('rejects a traversal disguised behind an allowlisted prefix', async () => {
    // raw specifier reaches onResolve unnormalized → exact-set check rejects it
    const res = await bundleReact("import x from 'react-dom/../../../etc/passwd'; export default () => x;");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not allowed/i);
  });

  it('rejects source exceeding the size cap', async () => {
    const huge = 'export default () => null;\n' + '//'.padEnd(600 * 1024, 'x');
    const res = await bundleReact(huge);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/512KB/i);
  });
});

describe('bundleMermaidRuntime (dev esbuild fallback)', () => {
  // process.resourcesPath is undefined under vitest, so this exercises the
  // dev-time live-esbuild path, bundling mermaid from the repo's node_modules.
  it('bundles a self-contained runtime that exposes __renderMermaid', async () => {
    const res = await bundleMermaidRuntime();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.code).toContain('__renderMermaid');
      // Non-trivial bundle (mermaid + deps), not an empty/error stub.
      expect(res.code.length).toBeGreaterThan(500 * 1024);
    }
  }, 60000);

  it('caches the runtime (second call returns the same code without rebuilding)', async () => {
    const a = await bundleMermaidRuntime();
    const b = await bundleMermaidRuntime();
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.code).toBe(a.code);
  }, 60000);
});
