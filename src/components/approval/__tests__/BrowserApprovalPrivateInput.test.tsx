import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserApprovalPrivateInput } from '../BrowserApprovalPrivateInput';

const getToolApprovalPrivateDetails = vi.fn();

beforeEach(() => {
  getToolApprovalPrivateDetails.mockReset().mockResolvedValue(null);
  (window as unknown as { app: unknown }).app = {
    agent: { getToolApprovalPrivateDetails },
  };
});

describe('BrowserApprovalPrivateInput', () => {
  it('fetches and displays exact script text only for a Browser-control approval', async () => {
    getToolApprovalPrivateDetails.mockResolvedValue({
      browserInput: { script: 'document.querySelector("#save").click()' },
    });
    render(
      <BrowserApprovalPrivateInput
        approvalId="approval-1"
        args={{ approvalKind: 'browser-control', script: '[redacted browser script: 41 characters]' }}
      />,
    );

    expect(await screen.findByTestId('browser-private-approval-input')).toHaveTextContent(
      'document.querySelector("#save").click()',
    );
    expect(getToolApprovalPrivateDetails).toHaveBeenCalledWith('approval-1');
  });

  it('does not fetch or retain private input when the approval is inactive', async () => {
    getToolApprovalPrivateDetails.mockResolvedValue({ browserInput: { script: 'secret-script' } });
    const { rerender } = render(
      <BrowserApprovalPrivateInput approvalId="approval-2" args={{ approvalKind: 'browser-control' }} />,
    );
    expect(await screen.findByText('secret-script')).toBeInTheDocument();

    rerender(
      <BrowserApprovalPrivateInput approvalId="approval-2" args={{ approvalKind: 'browser-control' }} active={false} />,
    );
    expect(screen.queryByText('secret-script')).toBeNull();
  });

  it('ignores ordinary approvals', () => {
    render(<BrowserApprovalPrivateInput approvalId="approval-3" args={{ reason: 'generic' }} />);
    expect(getToolApprovalPrivateDetails).not.toHaveBeenCalled();
  });
});
