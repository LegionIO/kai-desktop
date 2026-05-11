/**
 * Agent Role Matching — uses Haiku to match user descriptions to role templates
 * and generate a thematic name for the agent in a single call.
 *
 * Follows the same pattern as title-generation.ts: resolve Haiku model,
 * create a Mastra Agent, call generate with maxSteps: 1.
 */

import { resolveTitleModel } from './title-generation.js';
import { createLanguageModelFromConfig } from './language-model.js';
import { AGENT_ROLE_CATALOG, type AgentRoleEntry } from './agent-roles.js';
import type { AppConfig } from '../config/schema.js';

const MATCH_SYSTEM_PROMPT = `You are a role-matching assistant. Given a user's description of what they want an agent to do, you must:
1. Select the single best matching role from the provided catalog.
2. Generate a short, memorable 2-word name for the agent that reflects its role and personality.

The name should:
- Be two words: an evocative adjective or qualifier + a strong noun (e.g. "Iron Sentinel", "Swift Auditor", "Deep Forge")
- Feel thematic to the role — a security agent might get "Iron Sentinel", a frontend dev might get "Vivid Craft", a researcher might get "Deep Scout"
- Sound like a codename, not a job title
- Use title case

Respond with ONLY a JSON object in this exact format (no markdown, no explanation):
{"roleId": "engineering/engineering-code-reviewer", "name": "Sharp Lens"}

If no role is a good match, use "none" for roleId but still generate a fitting name:
{"roleId": "none", "name": "Swift Agent"}`;

export interface RoleMatchResult {
  role: AgentRoleEntry | null;
  name: string;
}

/**
 * Match a user's description to the best role from the catalog and generate
 * a thematic name — both in a single Haiku call.
 * Falls back to null role and a random name if the model is unavailable.
 */
export async function matchAgentRole(
  userDescription: string,
  config: AppConfig,
  existingNames: string[] = [],
): Promise<RoleMatchResult> {
  try {
    const modelEntry = resolveTitleModel(config, null);
    if (!modelEntry) return { role: null, name: '' };

    const catalogText = AGENT_ROLE_CATALOG
      .map((r) => `- ${r.id} | ${r.name} (${r.division}): ${r.description}`)
      .join('\n');

    const existingNamesNote = existingNames.length > 0
      ? `\n\nAvoid these already-used names: ${existingNames.join(', ')}`
      : '';

    const input = `Available roles:\n${catalogText}\n\nUser wants: "${userDescription}"${existingNamesNote}\n\nRespond with JSON:`;

    const { Agent } = await import('@mastra/core/agent');
    const model = await createLanguageModelFromConfig(modelEntry.modelConfig);
    type AgentConfig = ConstructorParameters<typeof Agent>[0];

    const agent = new Agent({
      id: `role-match-${Date.now()}`,
      name: 'role-matcher',
      instructions: MATCH_SYSTEM_PROMPT,
      model: model as AgentConfig['model'],
    });

    const result = await agent.generate(input, { maxSteps: 1 });
    const rawResponse = (typeof result.text === 'string' ? result.text : '').trim();

    // Strip markdown code fences if present
    const jsonText = rawResponse.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let parsed: { roleId?: string; name?: string } = {};
    try {
      parsed = JSON.parse(jsonText) as { roleId?: string; name?: string };
    } catch {
      console.warn('[RoleMatch] Failed to parse JSON response:', rawResponse);
      return { role: null, name: '' };
    }

    // Resolve role
    const roleId = typeof parsed.roleId === 'string' ? parsed.roleId.trim().toLowerCase() : '';
    let role: AgentRoleEntry | null = null;
    if (roleId && roleId !== 'none') {
      role = AGENT_ROLE_CATALOG.find((r) => r.id === roleId)
        ?? AGENT_ROLE_CATALOG.find((r) => roleId.includes(r.id))
        ?? null;
    }

    // Resolve name — accept any non-empty string of 2-4 words, trim whitespace
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    const nameIsValid = name.length >= 3 && name.length <= 40 && /^\S+(\s\S+)+$/.test(name);

    return { role, name: nameIsValid ? name : '' };
  } catch (error) {
    console.warn('[RoleMatch] Failed to match agent role:', error);
    return { role: null, name: '' };
  }
}
