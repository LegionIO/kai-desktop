/**
 * AgentProvider — React Context + useReducer store for agent management.
 *
 * Manages persistent agent entities in the renderer and syncs with the
 * main process via IPC. Follows the same Context pattern as TaskProvider.
 */

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  useCallback,
  useMemo,
  type FC,
  type PropsWithChildren,
} from 'react';
import { app } from '@/lib/ipc-client';
import type { AgentFile, CreateAgentPayload } from '../../shared/agent-types';

// ── State & Actions ──────────────────────────────────────────────────────

interface AgentState {
  agents: AgentFile[];
  selectedAgentId: string | null;
  isLoading: boolean;
}

type AgentAction =
  | { type: 'SET_AGENTS'; agents: AgentFile[] }
  | { type: 'ADD_AGENT'; agent: AgentFile }
  | { type: 'UPDATE_AGENT'; id: string; updates: Partial<AgentFile> }
  | { type: 'DELETE_AGENT'; id: string }
  | { type: 'SELECT_AGENT'; id: string | null }
  | { type: 'SET_LOADING'; loading: boolean };

const initialState: AgentState = {
  agents: [],
  selectedAgentId: null,
  isLoading: true,
};

function agentReducer(state: AgentState, action: AgentAction): AgentState {
  switch (action.type) {
    case 'SET_AGENTS':
      return { ...state, agents: action.agents, isLoading: false };
    case 'ADD_AGENT':
      return { ...state, agents: [action.agent, ...state.agents] };
    case 'UPDATE_AGENT':
      return {
        ...state,
        agents: state.agents.map((a) =>
          a.id === action.id ? { ...a, ...action.updates, id: action.id } : a,
        ),
      };
    case 'DELETE_AGENT':
      return {
        ...state,
        agents: state.agents.filter((a) => a.id !== action.id),
        selectedAgentId: state.selectedAgentId === action.id ? null : state.selectedAgentId,
      };
    case 'SELECT_AGENT':
      return { ...state, selectedAgentId: action.id };
    case 'SET_LOADING':
      return { ...state, isLoading: action.loading };
    default:
      return state;
  }
}

// ── Context ──────────────────────────────────────────────────────────────

interface AgentContextValue {
  state: AgentState;

  /** Create a new agent. */
  createAgent: (payload: CreateAgentPayload) => Promise<AgentFile | null>;

  /** Permanently delete an agent. */
  deleteAgent: (id: string) => Promise<void>;

  /** Update an existing agent's config or metadata. */
  updateAgent: (id: string, updates: Partial<AgentFile>) => Promise<void>;

  /** Select an agent (for detail view). */
  selectAgent: (id: string | null) => void;

  /** Assign a task to an agent. */
  assignTask: (agentId: string, taskId: string) => Promise<{ ok: boolean; error?: string }>;

  /** Unassign the current task from an agent. */
  unassignTask: (agentId: string) => Promise<{ ok: boolean; error?: string }>;

  /** Start the agent (spawn terminal for its current task). */
  startAgent: (agentId: string) => Promise<{ sessionId?: string; error?: string }>;

  /** Stop the agent (kill terminal). */
  stopAgent: (agentId: string) => Promise<void>;
}

const AgentContext = createContext<AgentContextValue | null>(null);

// ── Provider ─────────────────────────────────────────────────────────────

export const AgentProvider: FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(agentReducer, initialState);

  // Hydrate on mount
  useEffect(() => {
    if (!window.app?.agents) {
      dispatch({ type: 'SET_LOADING', loading: false });
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const agents = await app.agents.list();
        if (cancelled) return;
        dispatch({ type: 'SET_AGENTS', agents });
      } catch (err) {
        console.error('[AgentProvider] Failed to load agents:', err);
        if (!cancelled) dispatch({ type: 'SET_LOADING', loading: false });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to IPC broadcasts (changes from main process)
  useEffect(() => {
    if (!window.app?.agents?.onChanged) return;
    const unsub = app.agents.onChanged((agents) => {
      dispatch({ type: 'SET_AGENTS', agents });
    });
    return unsub;
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────

  const createAgent = useCallback(
    async (payload: CreateAgentPayload): Promise<AgentFile | null> => {
      try {
        const agent = await app.agents.create(payload);
        // Broadcast from main process triggers SET_AGENTS
        return agent;
      } catch (err) {
        console.error('[AgentProvider] Failed to create agent:', err);
        return null;
      }
    },
    [],
  );

  const deleteAgent = useCallback(async (id: string) => {
    try {
      await app.agents.delete(id);
      // Broadcast handles state update
    } catch (err) {
      console.error('[AgentProvider] Failed to delete agent:', err);
    }
  }, []);

  const updateAgent = useCallback(async (id: string, updates: Partial<AgentFile>) => {
    try {
      await app.agents.update(id, updates);
    } catch (err) {
      console.error('[AgentProvider] Failed to update agent:', err);
    }
  }, []);

  const selectAgent = useCallback((id: string | null) => {
    dispatch({ type: 'SELECT_AGENT', id });
  }, []);

  const assignTask = useCallback(
    async (agentId: string, taskId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const result = await app.agents.assignTask(agentId, taskId);
        return result;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    [],
  );

  const unassignTask = useCallback(
    async (agentId: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        const result = await app.agents.unassignTask(agentId);
        return result;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    [],
  );

  const startAgent = useCallback(
    async (agentId: string): Promise<{ sessionId?: string; error?: string }> => {
      try {
        const result = await app.agents.start(agentId);
        return result;
      } catch (err) {
        return { error: String(err) };
      }
    },
    [],
  );

  const stopAgent = useCallback(async (agentId: string) => {
    try {
      await app.agents.stop(agentId);
    } catch (err) {
      console.error('[AgentProvider] Failed to stop agent:', err);
    }
  }, []);

  // ── Memoized context value ─────────────────────────────────────────

  const value = useMemo<AgentContextValue>(
    () => ({
      state,
      createAgent,
      deleteAgent,
      updateAgent,
      selectAgent,
      assignTask,
      unassignTask,
      startAgent,
      stopAgent,
    }),
    [state, createAgent, deleteAgent, updateAgent, selectAgent, assignTask, unassignTask, startAgent, stopAgent],
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
};

// ── Hook ─────────────────────────────────────────────────────────────────

export function useAgents(): AgentContextValue {
  const context = useContext(AgentContext);
  if (!context) {
    throw new Error('useAgents must be used within an AgentProvider');
  }
  return context;
}
