/**
 * AgentSwarmView — orchestrator for the Agents main panel.
 *
 * Routes between three sub-views based on state:
 * 1. Creation mode → AgentCreationView (splash + composer)
 * 2. Agent selected → AgentDetailView (config + instructions)
 * 3. Default → AgentRosterView (vertical list of all agents)
 */

import type { FC } from 'react';
import { useAgents } from '@/providers/AgentProvider';
import { AgentCreationView } from './AgentCreationView';
import { AgentDetailView } from './AgentDetailView';
import { AgentRosterView } from './AgentRosterView';

export const AgentSwarmView: FC = () => {
  const { state } = useAgents();
  const { agents, selectedAgentId, isCreatingAgent } = state;

  // Creation mode: splash screen + composer
  if (isCreatingAgent) {
    return <AgentCreationView />;
  }

  // Detail view: selected agent
  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;
  if (selectedAgent) {
    return <AgentDetailView agent={selectedAgent} />;
  }

  // Default: vertical roster of all agents
  return <AgentRosterView />;
};
