import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { SidePanelHost, SidePanelProvider, useSidePanel } from '../SidePanelHost';

const Controls = () => {
  const { openPanel } = useSidePanel();
  return (
    <button type="button" onClick={() => openPanel('browser')}>
      Open Browser panel
    </button>
  );
};

describe('SidePanelHost', () => {
  it('remembers visibility and tab selection independently for each conversation', () => {
    const State = () => {
      const panel = useSidePanel();
      return (
        <>
          <output>{`${panel.state}:${panel.activeTabId ?? 'none'}`}</output>
          <button onClick={() => panel.openPanel('preview')}>Preview</button>
          <button onClick={() => panel.openPanel('changes')}>Changes</button>
          <button onClick={panel.closePanel}>Collapse</button>
        </>
      );
    };
    const ui = (id: string | null) => (
      <SidePanelProvider conversationId={id}>
        <State />
      </SidePanelProvider>
    );
    const view = render(ui('A'));
    fireEvent.click(screen.getByText('Preview'));
    expect(screen.getByRole('status')).toHaveTextContent('open:preview');

    view.rerender(ui('B'));
    expect(screen.getByRole('status')).toHaveTextContent('minimized:none');
    fireEvent.click(screen.getByText('Changes'));
    fireEvent.click(screen.getByText('Collapse'));
    expect(screen.getByRole('status')).toHaveTextContent('minimized:changes');

    view.rerender(ui('A'));
    expect(screen.getByRole('status')).toHaveTextContent('open:preview');
    view.rerender(ui('B'));
    expect(screen.getByRole('status')).toHaveTextContent('minimized:changes');
    view.rerender(ui(null));
    expect(screen.getByRole('status')).toHaveTextContent('minimized:none');
  });

  it('keeps delayed actions with their owner and allows explicit async navigation targets', () => {
    let conversationId = 'A';
    const wrapper = ({ children }: PropsWithChildren) => (
      <SidePanelProvider conversationId={conversationId}>{children}</SidePanelProvider>
    );
    const { result, rerender } = renderHook(() => useSidePanel(), { wrapper });
    const openFromA = result.current.openPanel;
    conversationId = 'B';
    rerender();
    act(() => openFromA('preview'));
    expect(result.current.state).toBe('minimized');
    expect(result.current.activeTabId).toBeNull();
    act(() => openFromA('browser', 'B'));
    expect(result.current.state).toBe('open');
    expect(result.current.activeTabId).toBe('browser');
    conversationId = 'A';
    rerender();
    expect(result.current.activeTabId).toBe('preview');
  });

  it('uses an opaque elevated surface so title-bar controls cannot bleed through it', () => {
    render(
      <TooltipProvider>
        <SidePanelProvider>
          <Controls />
          <SidePanelHost tabs={[{ id: 'browser', label: 'Browser', render: () => <div>Browser body</div> }]} />
        </SidePanelProvider>
      </TooltipProvider>,
    );

    const minimized = document.querySelector('[data-side-panel-surface="minimized"]');
    expect(minimized).toHaveClass('bg-card');
    expect(minimized).not.toHaveClass('bg-card/40');

    fireEvent.click(screen.getByRole('button', { name: 'Open Browser panel' }));

    const open = document.querySelector('[data-side-panel-surface="open"]');
    expect(open).toHaveClass('bg-card');
    expect(open).not.toHaveClass('bg-card/40');
    expect(screen.getByText('Browser body')).toBeInTheDocument();
  });
});
