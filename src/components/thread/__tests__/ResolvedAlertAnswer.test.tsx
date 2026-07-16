/**
 * Component test — ResolvedAlertAnswer renders the user's recorded outcome for a
 * suspended request_review/ask_user alert once it's answered elsewhere (pop-out
 * or Alerts tab), so the inline card flips from "awaiting" to the actual
 * answer/selections.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResolvedAlertAnswer, type AlertLike } from '../ToolGroup';

describe('ResolvedAlertAnswer', () => {
  it('shows the question answers mapped from header → question text', () => {
    const alert: AlertLike = {
      id: 'a1',
      kind: 'question',
      status: 'answered',
      questions: [
        { header: 'Color', question: 'Which color?' },
        { header: 'Size', question: 'What size?' },
      ],
      answer: { Color: 'Blue', Size: 'Large' },
    };
    render(<ResolvedAlertAnswer alert={alert} />);
    expect(screen.getByText('Answered', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Which color?', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Blue', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('What size?', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Large', { exact: false })).toBeInTheDocument();
  });

  it('shows Approved with the action for an approval decision', () => {
    const alert: AlertLike = {
      id: 'a2',
      kind: 'approval',
      status: 'answered',
      approvalAction: 'deploy prod',
      answer: 'approve',
    };
    render(<ResolvedAlertAnswer alert={alert} />);
    expect(screen.getByText('Approved', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('deploy prod', { exact: false })).toBeInTheDocument();
  });

  it('shows Denied for a deny decision', () => {
    const alert: AlertLike = { id: 'a3', kind: 'approval', status: 'answered', answer: 'deny' };
    render(<ResolvedAlertAnswer alert={alert} />);
    expect(screen.getByText('Denied', { exact: false })).toBeInTheDocument();
  });

  it('falls back to a bare Answered when no structured answer is present', () => {
    const alert: AlertLike = { id: 'a4', kind: 'question', status: 'answered' };
    render(<ResolvedAlertAnswer alert={alert} />);
    expect(screen.getByText('Answered', { exact: false })).toBeInTheDocument();
  });
});
