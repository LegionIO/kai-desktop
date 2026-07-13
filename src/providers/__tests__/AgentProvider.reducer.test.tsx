/**
 * Tests for AgentProvider's pure reducer (via __internal) — a plain
 * (state, action) → state machine backing the agent-management store. Locks the
 * id-preservation on UPDATE (an update can't rewrite the agent's id), the
 * selection-clearing on DELETE (a deleted-but-selected agent clears selection,
 * a different delete keeps it), ADD prepending newest-first, and the immutable
 * synthesizingIds Set add/remove.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../AgentProvider';
import type { AgentFile } from '../../../shared/agent-types';

const { agentReducer, initialState } = __internal;
const agent = (id: string, over: Partial<AgentFile> = {}): AgentFile => ({ id, name: id, ...over }) as AgentFile;

describe('agentReducer', () => {
  it('SET_AGENTS replaces agents and clears loading', () => {
    const s = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a'), agent('b')] });
    expect(s.agents.map((a) => a.id)).toEqual(['a', 'b']);
    expect(s.isLoading).toBe(false);
  });

  it('ADD_AGENT prepends (newest first)', () => {
    const base = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a')] });
    const s = agentReducer(base, { type: 'ADD_AGENT', agent: agent('b') });
    expect(s.agents.map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('UPDATE_AGENT merges updates but never lets updates overwrite the id', () => {
    const base = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a', { name: 'old' })] });
    const s = agentReducer(base, {
      type: 'UPDATE_AGENT',
      id: 'a',
      updates: { name: 'new', id: 'evil' } as Partial<AgentFile>,
    });
    expect(s.agents[0].id).toBe('a'); // id forced back to action.id
    expect(s.agents[0].name).toBe('new');
  });

  it('UPDATE_AGENT on an unknown id leaves agents unchanged', () => {
    const base = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a')] });
    const s = agentReducer(base, { type: 'UPDATE_AGENT', id: 'missing', updates: { name: 'x' } });
    expect(s.agents.map((a) => a.id)).toEqual(['a']);
    expect(s.agents[0].name).toBe('a');
  });

  it('DELETE_AGENT removes the agent AND clears selection when it was selected', () => {
    let s = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a'), agent('b')] });
    s = agentReducer(s, { type: 'SELECT_AGENT', id: 'a' });
    s = agentReducer(s, { type: 'DELETE_AGENT', id: 'a' });
    expect(s.agents.map((a) => a.id)).toEqual(['b']);
    expect(s.selectedAgentId).toBeNull();
  });

  it('DELETE_AGENT keeps selection when a DIFFERENT agent is deleted', () => {
    let s = agentReducer(initialState, { type: 'SET_AGENTS', agents: [agent('a'), agent('b')] });
    s = agentReducer(s, { type: 'SELECT_AGENT', id: 'a' });
    s = agentReducer(s, { type: 'DELETE_AGENT', id: 'b' });
    expect(s.selectedAgentId).toBe('a');
  });

  it('SET_CREATING and SET_LOADING update only their slice', () => {
    const creating = agentReducer(initialState, { type: 'SET_CREATING', creating: true });
    expect(creating.isCreatingAgent).toBe(true);
    const loaded = agentReducer(initialState, { type: 'SET_LOADING', loading: false });
    expect(loaded.isLoading).toBe(false);
  });

  it('SET_SYNTHESIZING adds then removes an id in a NEW Set each time (immutable)', () => {
    const added = agentReducer(initialState, { type: 'SET_SYNTHESIZING', id: 'a', synthesizing: true });
    expect(added.synthesizingIds.has('a')).toBe(true);
    expect(added.synthesizingIds).not.toBe(initialState.synthesizingIds); // new Set, not mutated
    const addedB = agentReducer(added, { type: 'SET_SYNTHESIZING', id: 'b', synthesizing: true });
    expect([...addedB.synthesizingIds].sort()).toEqual(['a', 'b']);
    const removed = agentReducer(addedB, { type: 'SET_SYNTHESIZING', id: 'a', synthesizing: false });
    expect(removed.synthesizingIds.has('a')).toBe(false);
    expect(removed.synthesizingIds.has('b')).toBe(true);
    // The prior state's Set is untouched (immutability).
    expect(addedB.synthesizingIds.has('a')).toBe(true);
  });

  it('returns the same state object for an unknown action', () => {
    const s = agentReducer(initialState, { type: 'NOPE' } as unknown as Parameters<typeof agentReducer>[1]);
    expect(s).toBe(initialState);
  });
});
