import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemorySettings } from '../MemorySettings';

vi.mock('@/lib/ipc-client', () => ({
  app: {
    memory: {
      testEmbedding: vi.fn(),
      clear: vi.fn(),
    },
  },
}));

function config(recentHistoryMode?: 'kai-branch' | 'merge-mastra'): Record<string, unknown> {
  return {
    memory: {
      enabled: true,
      ...(recentHistoryMode ? { recentHistoryMode } : {}),
      lastMessages: 12,
      workingMemory: { enabled: true, scope: 'resource' },
      observationalMemory: { enabled: true, scope: 'resource' },
      semanticRecall: {
        enabled: false,
        topK: 4,
        scope: 'resource',
        embeddingProvider: { type: 'azure', model: 'text-embedding-3-small' },
      },
    },
  };
}

describe('MemorySettings recent history mode', () => {
  it('defaults legacy config to the authoritative Kai branch and hides the unused count', () => {
    render(<MemorySettings config={config()} updateConfig={vi.fn()} />);

    expect(screen.getByDisplayValue('Kai active branch (recommended)')).toBeTruthy();
    expect(screen.queryByText('Mastra messages to merge')).toBeNull();
  });

  it('shows the bounded count in merge mode and writes the selected mode path', () => {
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    render(<MemorySettings config={config('merge-mastra')} updateConfig={updateConfig} />);

    expect(screen.getByText('Mastra messages to merge')).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue('Merge Mastra history (deduplicated)'), {
      target: { value: 'kai-branch' },
    });
    expect(updateConfig).toHaveBeenCalledWith('memory.recentHistoryMode', 'kai-branch');
  });
});
