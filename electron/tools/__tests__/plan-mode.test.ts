/**
 * Tests for plan-mode.ts slugifyPlanTitle (via __internal). exit_plan_mode
 * writes ~/.kai/plans/<slug>.md where <slug> comes from a MODEL-supplied
 * planTitle. The slug must be a single safe filename segment so a traversal- or
 * separator-laden title can't escape the plans dir, and must never be empty
 * (which would yield a degenerate ".md" file).
 */
import { describe, it, expect, vi } from 'vitest';

// plan-mode.ts imports electron (BrowserWindow) at module load.
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../web-server/web-clients.js', () => ({ broadcastToWebClients: vi.fn() }));

import { __internal } from '../plan-mode.js';
import { createExitPlanModeTool } from '../plan-mode.js';

const { slugifyPlanTitle } = __internal;

describe('slugifyPlanTitle', () => {
  it('lowercases + hyphenates a normal title', () => {
    expect(slugifyPlanTitle('Add Dark Mode')).toBe('add-dark-mode');
    expect(slugifyPlanTitle('Fix Bug #42!')).toBe('fix-bug-42');
  });

  it('collapses a traversal/separator title to a plain in-dir slug (no escape)', () => {
    // Every non-alphanumeric run → '-', so no '/', '\', '..', or leading dot survives.
    expect(slugifyPlanTitle('../../etc/passwd')).toBe('etc-passwd');
    expect(slugifyPlanTitle('..\\..\\windows\\system32')).toBe('windows-system32');
    expect(slugifyPlanTitle('/absolute/path')).toBe('absolute-path');
    for (const t of ['../../etc/passwd', '..\\x', '/a/b', 'a/../b']) {
      const s = slugifyPlanTitle(t);
      expect(s.includes('/'), t).toBe(false);
      expect(s.includes('\\'), t).toBe(false);
      expect(s.includes('..'), t).toBe(false);
      expect(/^[a-z0-9-]*$/.test(s) || /^[a-z]+-[a-z]+-[a-z]+$/.test(s), t).toBe(true);
    }
  });

  it('falls back to a random name when the title is absent', () => {
    const s = slugifyPlanTitle(undefined);
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/); // generatePlanName shape
  });

  it('falls back to a random name when the title sanitizes to EMPTY (would be ".md")', () => {
    for (const t of ['!!!', '../', '@#$%', '   ', '-', '...']) {
      const s = slugifyPlanTitle(t);
      expect(s.length, JSON.stringify(t)).toBeGreaterThan(0);
      expect(s, JSON.stringify(t)).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    }
  });

  it('caps the slug at 60 chars', () => {
    const s = slugifyPlanTitle('a'.repeat(200));
    expect(s.length).toBe(60);
  });
});

describe('exit_plan_mode size cap', () => {
  it('rejects an oversized plan before writing anything', async () => {
    const tool = createExitPlanModeTool();
    const huge = 'x'.repeat(1024 * 1024 + 1); // 1 MiB + 1 byte
    const res = (await tool.execute!({ planContent: huge, planTitle: 'big' }, {
      toolCallId: 't1',
    } as never)) as { success?: boolean; error?: string };
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/too large/i);
  });
});
