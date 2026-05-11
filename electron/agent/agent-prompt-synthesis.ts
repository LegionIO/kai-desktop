/**
 * Agent Prompt Synthesis — combines role template + user description into a system prompt.
 *
 * Uses the user's profile model (or default) to synthesize a focused system prompt
 * by merging the role template with the user's specific requirements.
 */

import { resolveModelForThread } from './model-catalog.js';
import { createLanguageModelFromConfig } from './language-model.js';
import type { AppConfig } from '../config/schema.js';

const SYNTHESIS_SYSTEM_PROMPT = `You are an expert at writing system prompts for AI agents. Your task is to synthesize a focused, actionable system prompt for an AI agent.

You will be given:
1. A role template (optional) — a detailed role definition with identity, mission, rules, and style
2. A user's description — what they specifically want this agent to do

Your output should be a well-structured system prompt that:
- Incorporates the role template's expertise, personality, and methodology (if provided)
- Tailors it specifically to the user's stated needs and context
- Is written in second person ("You are...", "You should...")
- Is concise but comprehensive (aim for 300-800 words)
- Includes clear behavioral guidelines
- Omits metadata/YAML front matter from the template

If no role template is provided, create a system prompt purely from the user's description.

Output ONLY the system prompt text. No explanations, no markdown headings wrapping it.`;

/**
 * Synthesize a system prompt for an agent by combining a role template with
 * the user's description. Falls back to the raw description on failure.
 */
export async function synthesizeAgentPrompt(
  roleTemplate: string | null,
  userDescription: string,
  config: AppConfig,
): Promise<string> {
  try {
    const modelEntry = resolveModelForThread(config, null);
    if (!modelEntry) return userDescription;

    let input: string;
    if (roleTemplate) {
      input = `## Role Template\n\n${roleTemplate}\n\n## User's Description\n\n${userDescription}\n\nSynthesize a system prompt for this agent:`;
    } else {
      input = `## User's Description\n\n${userDescription}\n\nCreate a system prompt for an AI agent based on this description:`;
    }

    const { Agent } = await import('@mastra/core/agent');
    const model = await createLanguageModelFromConfig(modelEntry.modelConfig);
    type AgentConfig = ConstructorParameters<typeof Agent>[0];

    const agent = new Agent({
      id: `prompt-synth-${Date.now()}`,
      name: 'prompt-synthesizer',
      instructions: SYNTHESIS_SYSTEM_PROMPT,
      model: model as AgentConfig['model'],
    });

    const result = await agent.generate(input, { maxSteps: 1 });
    const synthesized = typeof result.text === 'string' ? result.text.trim() : null;

    if (synthesized && synthesized.length > 50) {
      return synthesized;
    }

    // If synthesis produced something too short, fall back
    return userDescription;
  } catch (error) {
    console.warn('[PromptSynth] Failed to synthesize agent prompt:', error);
    return userDescription;
  }
}
