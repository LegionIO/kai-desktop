import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationArtifactProvider } from '../ConversationArtifactProvider';
import { ArtifactToolCard } from '@/components/thread/ArtifactToolCard';
import { ArtifactPanel } from '@/components/side-panel/ArtifactPanel';
import { SidePanelHost, SidePanelProvider } from '@/components/side-panel/SidePanelHost';
import { TooltipProvider } from '@/components/ui/Tooltip';

const runtime = vi.hoisted(() => ({ conversationId: 'A' as string | null }));
vi.mock('@/providers/RuntimeProvider', () => ({ useRuntimeConversationId: () => runtime.conversationId }));
vi.mock('@/components/side-panel/artifact-views/ArtifactRenderer', () => ({
  ArtifactRenderer: ({ content }: { content: string }) => <div data-testid="preview-content">{content}</div>,
}));
vi.mock('@/components/thread/CodeBlock', () => ({ CodeBlock: () => null }));

const resultFor = (id: string) => ({
  artifact: { id: 'shared-artifact-id', title: `Preview ${id}`, type: 'text', content: `Only ${id}` },
});

function Conversation({
  selectedId,
  artifactId,
  pending = false,
}: {
  selectedId: string | null;
  artifactId?: string;
  pending?: boolean;
}) {
  return (
    <TooltipProvider>
      <SidePanelProvider conversationId={selectedId}>
        <ConversationArtifactProvider conversationId={selectedId}>
          <div data-testid="messages">
            {artifactId && (
              <ArtifactToolCard
                key={artifactId}
                toolCallId={`create-${artifactId}`}
                toolName="create_artifact"
                args={{}}
                result={pending ? undefined : resultFor(artifactId)}
                isError={false}
              />
            )}
          </div>
          <SidePanelHost tabs={[{ id: 'preview', label: 'Preview', render: () => <ArtifactPanel /> }]} />
        </ConversationArtifactProvider>
      </SidePanelProvider>
    </TooltipProvider>
  );
}

describe('conversation preview isolation', () => {
  beforeEach(() => {
    runtime.conversationId = 'A';
  });

  it('rejects old message cards while loading, including after collapse and reopen', () => {
    const view = render(<Conversation selectedId="A" artifactId="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('preview-content')).toHaveTextContent('Only A');

    view.rerender(<Conversation selectedId="B" artifactId="A" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading chat');
    expect(screen.queryByTestId('preview-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('messages')).not.toBeInTheDocument();

    runtime.conversationId = 'B';
    view.rerender(<Conversation selectedId="B" />);
    expect(screen.queryByRole('button', { name: 'Collapse panel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('No preview yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('No preview yet')).toBeInTheDocument();

    view.rerender(<Conversation selectedId="A" />);
    runtime.conversationId = 'A';
    view.rerender(<Conversation selectedId="A" artifactId="A" />);
    expect(screen.getByTestId('preview-content')).toHaveTextContent('Only A');
  });

  it('isolates reused artifact IDs and restores collapsed previews without auto-opening', () => {
    const view = render(<Conversation selectedId="A" artifactId="A" pending />);
    view.rerender(<Conversation selectedId="A" artifactId="A" />);
    expect(screen.getByTestId('preview-content')).toHaveTextContent('Only A');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));

    view.rerender(<Conversation selectedId="B" artifactId="A" />);
    runtime.conversationId = 'B';
    view.rerender(<Conversation selectedId="B" artifactId="B" />);
    fireEvent.click(within(screen.getByTestId('messages')).getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('preview-content')).toHaveTextContent('Only B');

    view.rerender(<Conversation selectedId="A" artifactId="B" />);
    runtime.conversationId = 'A';
    view.rerender(<Conversation selectedId="A" artifactId="A" />);
    expect(screen.queryByTestId('preview-content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByTestId('preview-content')).toHaveTextContent('Only A');
  });

  it('ignores intermediate and empty selections until the selected messages are loaded', () => {
    const view = render(<Conversation selectedId="A" artifactId="A" />);
    view.rerender(<Conversation selectedId="B" artifactId="A" />);
    view.rerender(<Conversation selectedId="C" artifactId="A" />);
    runtime.conversationId = 'B';
    view.rerender(<Conversation selectedId="C" artifactId="B" />);
    expect(screen.queryByTestId('messages')).not.toBeInTheDocument();
    runtime.conversationId = 'C';
    view.rerender(<Conversation selectedId="C" />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('No preview yet')).toBeInTheDocument();
    view.rerender(<Conversation selectedId={null} />);
    expect(screen.queryByTestId('messages')).not.toBeInTheDocument();
  });
});
