import type { AgentState } from './types.js';

/** Provider id of agents that never named one (terminal launches, Claude adoption). */
export const DEFAULT_PROVIDER_ID = 'claude';

/**
 * The `agentCreated` ServerMessage for a newly added agent. Shared by the
 * standalone WebSocket bridge (httpServer.ts) and the VS Code adapter so both
 * surfaces announce the same fields — including the provider (absent ⇒ 'claude')
 * and the watched agent's display label.
 */
export function agentCreatedMessage(id: number, agent: AgentState): Record<string, unknown> {
  return {
    type: 'agentCreated',
    id,
    directoryName: agent.directoryName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    parentAgentId: agent.leadAgentId,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    hueShift: agent.hueShift,
    providerId: agent.providerId ?? DEFAULT_PROVIDER_ID,
    agentLabel: agent.agentLabel,
  };
}

/** Provider fields for an `existingAgents.agentMeta[id]` entry. */
export function agentProviderMeta(agent: AgentState): { providerId: string; agentLabel?: string } {
  return {
    providerId: agent.providerId ?? DEFAULT_PROVIDER_ID,
    ...(agent.agentLabel ? { agentLabel: agent.agentLabel } : {}),
  };
}
