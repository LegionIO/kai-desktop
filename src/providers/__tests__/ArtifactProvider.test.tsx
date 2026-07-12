/**
 * Component test — ArtifactProvider.upsert version-history logic.
 *
 * upsert is the single mutation point for artifacts. Its contract:
 *   - a NEW id creates the artifact with one initial version + defaults
 *   - updating with CHANGED content pushes a new version
 *   - updating with the SAME content does NOT push a version (dedup) but still
 *     refreshes updatedAt / title / type
 *   - it returns the resulting record SYNCHRONOUSLY (setState may be async)
 *   - a rapid second upsert in the same tick sees the first (ref is synced
 *     immediately, before the effect runs)
 *
 * useSidePanelOptional returns null outside a SidePanelProvider, so the provider
 * renders standalone.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { ArtifactProvider, useArtifacts } from '../ArtifactProvider';

const wrapper = ({ children }: PropsWithChildren) => <ArtifactProvider>{children}</ArtifactProvider>;
const render = () => renderHook(() => useArtifacts(), { wrapper });

describe('ArtifactProvider.upsert', () => {
  it('creates a new artifact with one version and applied defaults', () => {
    const { result } = render();
    let record!: ReturnType<typeof result.current.upsert>;
    act(() => {
      record = result.current.upsert({ id: 'a1', content: 'hello' });
    });
    expect(record.id).toBe('a1');
    expect(record.title).toBe('Untitled');
    expect(record.type).toBe('text');
    expect(record.content).toBe('hello');
    expect(record.versions).toHaveLength(1);
    expect(record.versions[0].content).toBe('hello');
    // reflected in the map
    expect(result.current.artifacts.get('a1')?.content).toBe('hello');
    expect(result.current.activeId).toBe('a1');
  });

  it('pushes a new version when content changes', () => {
    const { result } = render();
    act(() => {
      result.current.upsert({ id: 'a1', content: 'v1', title: 'T', type: 'markdown' });
    });
    let updated!: ReturnType<typeof result.current.upsert>;
    act(() => {
      updated = result.current.upsert({ id: 'a1', content: 'v2' });
    });
    expect(updated.versions).toHaveLength(2);
    expect(updated.versions.map((v) => v.content)).toEqual(['v1', 'v2']);
    // unchanged fields carry over when not supplied
    expect(updated.title).toBe('T');
    expect(updated.type).toBe('markdown');
  });

  it('does NOT push a version when content is unchanged, but refreshes metadata', () => {
    const { result } = render();
    act(() => {
      result.current.upsert({ id: 'a1', content: 'same', title: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' });
    });
    let again!: ReturnType<typeof result.current.upsert>;
    act(() => {
      again = result.current.upsert({ id: 'a1', content: 'same', title: 'New', updatedAt: '2026-02-02T00:00:00.000Z' });
    });
    expect(again.versions).toHaveLength(1); // no new version
    expect(again.title).toBe('New'); // metadata refreshed
    expect(again.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('handles two rapid upserts in the SAME tick (ref synced before the effect)', () => {
    const { result } = render();
    let second!: ReturnType<typeof result.current.upsert>;
    act(() => {
      result.current.upsert({ id: 'a1', content: 'first' });
      // second call in the same act() — must see the first via the synced ref,
      // so it pushes a 2nd version rather than re-initializing.
      second = result.current.upsert({ id: 'a1', content: 'secondContent' });
    });
    expect(second.versions).toHaveLength(2);
    expect(second.versions.map((v) => v.content)).toEqual(['first', 'secondContent']);
  });

  it('tracks independent artifacts by id', () => {
    const { result } = render();
    act(() => {
      result.current.upsert({ id: 'a1', content: 'one' });
      result.current.upsert({ id: 'a2', content: 'two' });
    });
    expect(result.current.artifacts.size).toBe(2);
    expect(result.current.artifacts.get('a1')?.content).toBe('one');
    expect(result.current.artifacts.get('a2')?.content).toBe('two');
    expect(result.current.activeId).toBe('a2'); // last upsert wins active
  });
});
