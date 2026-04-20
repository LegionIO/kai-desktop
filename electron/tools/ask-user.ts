import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/**
 * Shared map where agent.ts stores user answers before the tool's execute runs.
 * Key: toolCallId, Value: user's answers keyed by question text.
 */
export const pendingQuestionAnswers = new Map<string, Record<string, string>>();

const questionOptionSchema = z.object({
  label: z.string().describe('Short display text for the option (1-5 words)'),
  description: z.string().optional().describe('Explanation of what this option means'),
});

const questionSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  header: z.string().max(12).describe('Short tab label (max 12 chars), e.g. "Auth method"'),
  options: z.array(questionOptionSchema).min(2).max(4).describe('Available choices (2-4 options)'),
  multiSelect: z.boolean().optional().default(false).describe('Allow multiple selections'),
});

export function createAskUserTool(): ToolDefinition {
  return {
    name: 'ask_user',
    description: [
      'Ask the user a question with multiple-choice options.',
      'Use this when you need clarification, want user preferences, or need a decision before proceeding.',
      'Each question has a short header for tab display, the question text, and 2-4 options.',
      'The user can also type a custom "Other" response.',
      'You can ask up to 4 questions at once — each appears as a tab.',
      'The tool blocks until the user responds.',
    ].join(' '),
    inputSchema: z.object({
      questions: z.array(questionSchema).min(1).max(4).describe('Questions to ask (1-4)'),
    }),
    execute: async (_input, context) => {
      // By the time execute runs, agent.ts has already stored the user's answers
      const answers = pendingQuestionAnswers.get(context.toolCallId);
      pendingQuestionAnswers.delete(context.toolCallId);

      if (!answers) {
        return { error: 'No user response received' };
      }

      return {
        success: true,
        answers,
      };
    },
  };
}
