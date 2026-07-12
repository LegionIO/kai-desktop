/**
 * Tests for TaskProvider's pure reducer (via __internal) — a plain
 * (state, action) → state machine, no rendering needed. It backs the task
 * board's client state, so the id-preservation on UPDATE, the selected-task
 * clearing on DELETE, and the streaming-text accumulation are the behaviors
 * worth locking.
 */
import { describe, it, expect } from 'vitest';
import { __internal } from '../TaskProvider';
import type { TaskFile } from '../../../shared/task-types';

const { taskReducer, initialState } = __internal;
const task = (id: string, over: Partial<TaskFile> = {}): TaskFile => ({ id, title: id, ...over }) as TaskFile;

describe('taskReducer', () => {
  it('SET_TASKS replaces tasks and clears loading', () => {
    const s = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a'), task('b')] });
    expect(s.tasks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(s.isLoading).toBe(false);
  });

  it('ADD_TASK prepends (newest first)', () => {
    const base = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a')] });
    const s = taskReducer(base, { type: 'ADD_TASK', task: task('b') });
    expect(s.tasks.map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('UPDATE_TASK merges updates but never lets updates overwrite the id', () => {
    const base = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a', { title: 'old' })] });
    const s = taskReducer(base, {
      type: 'UPDATE_TASK',
      id: 'a',
      updates: { title: 'new', id: 'evil' } as Partial<TaskFile>,
    });
    expect(s.tasks[0].id).toBe('a'); // id forced back to action.id
    expect(s.tasks[0].title).toBe('new');
  });

  it('UPDATE_TASK on an unknown id leaves tasks unchanged', () => {
    const base = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a')] });
    const s = taskReducer(base, { type: 'UPDATE_TASK', id: 'missing', updates: { title: 'x' } });
    expect(s.tasks.map((t) => t.id)).toEqual(['a']);
    expect(s.tasks[0].title).toBe('a');
  });

  it('DELETE_TASK removes the task AND clears selection when it was selected', () => {
    let s = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a'), task('b')] });
    s = taskReducer(s, { type: 'SELECT_TASK', id: 'a' });
    s = taskReducer(s, { type: 'DELETE_TASK', id: 'a' });
    expect(s.tasks.map((t) => t.id)).toEqual(['b']);
    expect(s.selectedTaskId).toBeNull();
  });

  it('DELETE_TASK keeps selection when a DIFFERENT task is deleted', () => {
    let s = taskReducer(initialState, { type: 'SET_TASKS', tasks: [task('a'), task('b')] });
    s = taskReducer(s, { type: 'SELECT_TASK', id: 'a' });
    s = taskReducer(s, { type: 'DELETE_TASK', id: 'b' });
    expect(s.selectedTaskId).toBe('a');
  });

  it('STREAM lifecycle: START resets text, DELTA accumulates, DONE stops, CANCEL clears', () => {
    let s = taskReducer(initialState, { type: 'START_AI_CREATE', taskId: 't1' });
    expect(s).toMatchObject({ creatingTaskId: 't1', streamingText: '', isStreamingPlan: true });
    s = taskReducer(s, { type: 'STREAM_TEXT_DELTA', text: 'Hello ' });
    s = taskReducer(s, { type: 'STREAM_TEXT_DELTA', text: 'world' });
    expect(s.streamingText).toBe('Hello world'); // accumulates
    const done = taskReducer(s, { type: 'STREAM_DONE' });
    expect(done.isStreamingPlan).toBe(false);
    expect(done.streamingText).toBe('Hello world'); // DONE keeps the text
    const cancelled = taskReducer(s, { type: 'CANCEL_AI_CREATE' });
    expect(cancelled).toMatchObject({ creatingTaskId: null, streamingText: '', isStreamingPlan: false });
  });

  it('SET_LOADING and SET_ORDER update only their slice', () => {
    const loaded = taskReducer(initialState, { type: 'SET_LOADING', loading: false });
    expect(loaded.isLoading).toBe(false);
    const order = { todo: ['a'], in_progress: [], blocked: [], ai_review: [], human_review: [], done: [] };
    const s = taskReducer(initialState, { type: 'SET_ORDER', order });
    expect(s.taskOrder.todo).toEqual(['a']);
  });

  it('returns the same state object for an unknown action', () => {
    const s = taskReducer(initialState, { type: 'NOPE' } as unknown as Parameters<typeof taskReducer>[1]);
    expect(s).toBe(initialState);
  });
});
