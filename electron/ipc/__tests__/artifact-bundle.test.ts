import { describe, expect, it } from 'vitest';
import { artifactBindsReact } from '../artifact-bundle.js';

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
});
