/**
 * Component tests for EditDiffSummary.
 *
 * Covers: render, config-off, zero-files, singular/plural file label,
 * truncation hint, and — critically — the XSS-literal-text case (any
 * HTML/script content in a file path must be rendered as literal text,
 * not injected into the DOM).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { EditDiffSummary } from '../EditDiffSummary';
import type { EditSummary } from '../../../../shared/edit-diff';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSummary(partial: Partial<EditSummary> = {}): EditSummary {
  return {
    filesChanged: 1,
    added: 3,
    removed: 1,
    perFile: [],
    hasTruncated: false,
    ...partial,
  };
}

afterEach(() => {
  cleanup();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('EditDiffSummary', () => {
  describe('renders nothing when disabled', () => {
    it('returns null when enabled=false', () => {
      const { container } = render(
        <EditDiffSummary summary={makeSummary({ filesChanged: 2, added: 5, removed: 2 })} enabled={false} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('renders nothing when no files changed', () => {
    it('returns null when filesChanged=0', () => {
      const { container } = render(
        <EditDiffSummary summary={makeSummary({ filesChanged: 0, added: 0, removed: 0 })} enabled={true} />,
      );
      expect(container.firstChild).toBeNull();
    });
  });

  describe('singular file label', () => {
    beforeEach(() => {
      render(<EditDiffSummary summary={makeSummary({ filesChanged: 1, added: 2, removed: 1 })} enabled={true} />);
    });

    it('renders "1 file changed" (singular)', () => {
      expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
    });

    it('renders the added count in emerald text', () => {
      const addedEl = screen.getByText('+2');
      expect(addedEl).toBeInTheDocument();
      expect(addedEl.className).toMatch(/emerald/);
    });

    it('renders the removed count in red text', () => {
      const removedEl = screen.getByText('−1');
      expect(removedEl).toBeInTheDocument();
      expect(removedEl.className).toMatch(/red/);
    });
  });

  describe('plural file label', () => {
    it('renders "3 files changed" (plural)', () => {
      render(<EditDiffSummary summary={makeSummary({ filesChanged: 3, added: 10, removed: 4 })} enabled={true} />);
      expect(screen.getByText(/3 files changed/)).toBeInTheDocument();
    });
  });

  describe('truncation hint', () => {
    it('shows the truncation hint when hasTruncated=true', () => {
      render(
        <EditDiffSummary
          summary={makeSummary({ filesChanged: 1, added: 200, removed: 200, hasTruncated: true })}
          enabled={true}
        />,
      );
      expect(screen.getByText('(approx.)')).toBeInTheDocument();
    });

    it('does NOT show the truncation hint when hasTruncated=false', () => {
      render(
        <EditDiffSummary
          summary={makeSummary({ filesChanged: 1, added: 5, removed: 2, hasTruncated: false })}
          enabled={true}
        />,
      );
      expect(screen.queryByText('(approx.)')).toBeNull();
    });
  });

  describe('zero added/removed edge cases', () => {
    it('does not render the added span when added=0', () => {
      render(
        <EditDiffSummary summary={makeSummary({ filesChanged: 1, added: 0, removed: 3 })} enabled={true} />,
      );
      expect(screen.queryByText(/^\+/)).toBeNull();
      expect(screen.getByText('−3')).toBeInTheDocument();
    });

    it('does not render the removed span when removed=0', () => {
      render(
        <EditDiffSummary summary={makeSummary({ filesChanged: 1, added: 5, removed: 0 })} enabled={true} />,
      );
      expect(screen.queryByText(/^−/)).toBeNull();
      expect(screen.getByText('+5')).toBeInTheDocument();
    });
  });

  describe('XSS safety — content rendered as literal text', () => {
    it('renders a new_string containing <img onerror=...> as literal text, not as DOM', () => {
      // This test verifies that ANY string value treated as file content is
      // rendered through React text nodes — never through innerHTML/dangerouslySetInnerHTML.
      // We construct an EditSummary that mimics what buildEditSummary would
      // produce from a file whose "content" happened to contain HTML markup.
      const xssPayload = '<img src=x onerror=alert(1)>';
      const summary: EditSummary = {
        filesChanged: 1,
        added: 1,
        removed: 0,
        hasTruncated: false,
        perFile: [
          {
            filePath: xssPayload,   // attacker-controlled path
            fileName: xssPayload,
            added: 1,
            removed: 0,
            kind: 'create',
            truncated: false,
            diffLines: [{ text: xssPayload, type: 'added' }],
          },
        ],
      };

      // EditDiffSummary does NOT render filePath/fileName — it only renders
      // filesChanged count (a number) and +N/−N counts (numbers).  This test
      // confirms the component never surfaces the raw string values.
      render(<EditDiffSummary summary={summary} enabled={true} />);

      // The component renders "1 file changed · +1" — no raw HTML attribute or
      // script content appears in the DOM.
      const summaryEl = screen.getByTestId('edit-diff-summary');
      expect(summaryEl).toBeInTheDocument();

      // innerHTML must not contain an img element — React should escape or
      // simply never include the raw xssPayload string in the rendered output.
      expect(summaryEl.innerHTML).not.toContain('<img');
      expect(summaryEl.innerHTML).not.toContain('onerror');

      // The visible text is numeric-only counts, not the raw payload.
      expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
    });

    it('renders </script> as literal text without closing a script context', () => {
      const xssPayload = '</script><script>alert(1)</script>';
      const summary: EditSummary = {
        filesChanged: 1,
        added: 1,
        removed: 0,
        hasTruncated: false,
        perFile: [
          {
            filePath: xssPayload,
            fileName: xssPayload,
            added: 1,
            removed: 0,
            kind: 'edit',
            truncated: false,
            diffLines: [{ text: xssPayload, type: 'added' }],
          },
        ],
      };

      render(<EditDiffSummary summary={summary} enabled={true} />);

      const summaryEl = screen.getByTestId('edit-diff-summary');
      // The injected script text must not appear as an executable script tag.
      expect(summaryEl.innerHTML).not.toContain('<script>');
      expect(screen.getByText(/1 file changed/)).toBeInTheDocument();
    });
  });
});
