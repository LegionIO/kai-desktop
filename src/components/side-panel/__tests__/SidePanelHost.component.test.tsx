import { fireEvent, render, screen } from '@testing-library/react';
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
