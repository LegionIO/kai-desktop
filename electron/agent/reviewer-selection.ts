/**
 * AI-powered reviewer selection for the autopilot scrum master.
 *
 * Given a task and a list of available reviewer agents, uses a fast model
 * to pick the N best-fit reviewers based on task content and agent capabilities.
 */

import type { AgentFile } from '../../shared/agent-types.js';
import type { TaskFile } from '../../shared/task-types.js';

/**
 * Use AI to select the best reviewer agents for a task.
 * Falls back to round-robin if AI is unavailable.
 */
export async function selectReviewers(
  task: TaskFile,
  availableReviewers: AgentFile[],
  count: number,
): Promise<string[]> {
  if (availableReviewers.length === 0) return [];
  if (availableReviewers.length <= count) {
    return availableReviewers.map((a) => a.id);
  }

  // Sort a COPY — never mutate the caller-owned array (aliasing bug).
  const byName = () => [...availableReviewers].sort((a, b) => a.name.localeCompare(b.name));

  // Try AI-powered selection
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback: pick first N reviewers (sorted by name for stability)
    return byName()
      .slice(0, count)
      .map((a) => a.id);
  }

  try {
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const { generateText } = await import('ai');

    const anthropic = createAnthropic({ apiKey });
    const model = anthropic('claude-3-5-haiku-latest');

    const prompt = [
      'You are selecting code reviewers for a task. Pick the best-fit reviewers.',
      'Return ONLY a JSON array of agent IDs (strings), ordered by best fit.',
      `Select exactly ${count} reviewers.`,
      '',
      `TASK TITLE: ${task.title}`,
      `TASK DESCRIPTION: ${(task.description ?? '').slice(0, 2000)}`,
      `TASK LABELS: ${(task.metadata?.labels ?? []).join(', ') || '(none)'}`,
      '',
      'AVAILABLE REVIEWERS:',
      ...availableReviewers.map(
        (a) =>
          `- ID: ${a.id} | Name: ${a.name} | Description: ${(a.description ?? '').slice(0, 300)} | Capabilities: ${(a.capabilities ?? []).join(', ') || '(none)'}`,
      ),
    ].join('\n');

    const { text } = await generateText({
      model,
      prompt,
      maxOutputTokens: 200,
    });

    return selectReviewersFromResponse(text ?? '', availableReviewers, count);
  } catch (err) {
    console.warn('[reviewer-selection] AI selection failed, using fallback:', err);
  }

  // Fallback: first N by name
  return byName()
    .slice(0, count)
    .map((a) => a.id);
}

/**
 * Pure parse+validate of the reviewer-selection model output. Extracts the first
 * JSON array from `text`, keeps only ids that exist in `availableReviewers`,
 * DEDUPEs (a repeated valid id must not satisfy the quorum and silently shrink
 * the set), and supplements from the remaining reviewers to reach `count`. On no
 * match / malformed JSON / too-few valid ids, falls back to the first `count`
 * reviewers by name. Never mutates the caller array. Exported for unit testing.
 */
export function selectReviewersFromResponse(text: string, availableReviewers: AgentFile[], count: number): string[] {
  const byName = (): string[] =>
    [...availableReviewers]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, count)
      .map((a) => a.id);

  const raw = text.trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return byName();

  let ids: unknown;
  try {
    ids = JSON.parse(match[0]);
  } catch {
    return byName();
  }
  if (!Array.isArray(ids)) return byName();

  const availableIds = new Set(availableReviewers.map((a) => a.id));
  const validIds = [...new Set(ids)].filter((id): id is string => typeof id === 'string' && availableIds.has(id));
  if (validIds.length >= count) return validIds.slice(0, count);
  // Supplement with remaining reviewers to reach `count`.
  const remaining = availableReviewers.filter((a) => !validIds.includes(a.id)).slice(0, count - validIds.length);
  return [...validIds, ...remaining.map((a) => a.id)].slice(0, count);
}
