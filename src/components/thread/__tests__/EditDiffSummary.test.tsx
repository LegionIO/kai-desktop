/**
 * Component tests for EditDiffSummary (issue #80).
 *
 * Renders against the real prop shape (`parts: EditToolCallLike[]`, computed
 * internally via the shared edit-diff core). Covers: config-off, zero-files,
 * singular/plural label, +/− color spans, truncation hint, zero added/removed
 * edge cases, and the XSS-literal-text case — any HTML/script content in a
 * file path or edited content must never reach the DOM as markup, since the
 * component surfaces only numeric counts through React text nodes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EditDiffSummary } from '../EditDiffSummary';
import type { EditToolCallLike } from '../../../../shared/edit-diff';

afterEach(() => {
  cleanup();
});

/** A Write tool call that creates a file with `content` (all lines counted as added). */
function writeCall(filePath: string, content: string): EditToolCallLike {
  return { toolName: 'Write', args: { file_path: filePath, content } };
}

/** An Edit tool call replacing old_string with new_string. */
function editCall(filePath: string, oldStr: string, newStr: string): EditToolCallLike {
  return { toolName: 'Edit', args: { file_path: filePath, old_string: oldStr, new_string: newStr } };
}

/** Build `n` lines of distinct text so a Write registers `n` added lines. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
}

describe('EditDiffSummary', () => {
  it('returns null when enabled=false', () => {
    const { container } = render(<EditDiffSummary parts={[writeCall('a.ts', lines(3))]} enabled={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null when no edit tool calls are present (zero files)', () => {
    const { container } = render(
      <EditDiffSummary parts={[{ toolName: 'Read', args: { file_path: 'a.ts' } }]} enabled={true} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders "1 file changed" (singular) with colored +/− counts', () => {
    render(<EditDiffSummary parts={[editCall('a.ts', 'old', 'new\nmore')]} enabled={true} />);
    expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
    const added = screen.getByText(/^\+\d+$/);
    expect(added.className).toMatch(/emerald/);
    const removed = screen.getByText(/^−\d+$/);
    expect(removed.className).toMatch(/red/);
  });

  it('renders "N files changed" (plural) across multiple distinct files', () => {
    render(
      <EditDiffSummary
        parts={[editCall('a.ts', 'x', 'y'), editCall('b.ts', 'p', 'q'), writeCall('c.ts', lines(2))]}
        enabled={true}
      />,
    );
    expect(screen.getByText(/3 files changed/)).toBeInTheDocument();
  });

  it('does not render the added span when there are no added lines', () => {
    // old_string has lines that new_string is a strict subset of → removals only, added=0.
    render(<EditDiffSummary parts={[editCall('a.ts', 'keep\ngone1\ngone2', 'keep')]} enabled={true} />);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
    expect(screen.getByText(/^−\d+$/)).toBeInTheDocument();
  });

  it('shows the (approx) hint when a large edit exceeds the diff line cap', () => {
    // >400 combined old+new lines forces the block-fallback truncation flag
    // (the LCS DP table is only allocated for edits with both sides present).
    const oldBig = Array.from({ length: 250 }, (_, i) => `old ${i}`).join('\n');
    const newBig = Array.from({ length: 250 }, (_, i) => `new ${i}`).join('\n');
    render(<EditDiffSummary parts={[editCall('big.ts', oldBig, newBig)]} enabled={true} />);
    expect(screen.getByText(/approx/)).toBeInTheDocument();
  });

  it('does not show the (approx) hint for a small edit', () => {
    render(<EditDiffSummary parts={[writeCall('small.ts', lines(3))]} enabled={true} />);
    expect(screen.queryByText(/approx/)).toBeNull();
  });

  it('renders HTML/script content in paths and edits as literal text, never as DOM', () => {
    const xssPath = '<img src=x onerror=alert(1)>.ts';
    const xssContent = '</script><script>alert(1)</script>';
    const { container } = render(<EditDiffSummary parts={[editCall(xssPath, 'old', xssContent)]} enabled={true} />);
    // The component surfaces only numeric counts, so no attacker string reaches the DOM.
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).not.toContain('onerror');
    expect(container.innerHTML).not.toContain('<script>');
    expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
  });
});
