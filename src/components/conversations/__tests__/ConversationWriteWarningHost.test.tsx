import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ConversationWriteWarningHost } from '../ConversationWriteWarningHost';
import { BROWSER_AUTHORITY_CONTINUATION_MESSAGE, surfaceConversationWriteWarning } from '@/lib/conversation-writes';

describe('ConversationWriteWarningHost', () => {
  it('shows Browser continuation guidance until dismissed', () => {
    render(<ConversationWriteWarningHost />);
    act(() => surfaceConversationWriteWarning(BROWSER_AUTHORITY_CONTINUATION_MESSAGE));

    expect(screen.getByRole('alert')).toHaveTextContent(BROWSER_AUTHORITY_CONTINUATION_MESSAGE);
    fireEvent.click(screen.getByLabelText('Dismiss chat save warning'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
