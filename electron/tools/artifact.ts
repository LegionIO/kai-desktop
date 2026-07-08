import { z } from 'zod';
import type { ToolDefinition } from './types.js';

/**
 * Artifact tools — agent-rendered live previews.
 *
 * The main process does not hold artifact state; the tool result is echoed
 * back to the renderer via the normal tool-result path, and the thread's
 * tool-result renderer (`ArtifactToolCard`) upserts the artifact into the
 * renderer-side `ArtifactProvider` and opens the side panel.
 */

export const artifactTypeSchema = z.enum(['html', 'markdown', 'svg', 'mermaid', 'react', 'text']);

export type ArtifactType = z.infer<typeof artifactTypeSchema>;

const createInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric, dash, or underscore')
    .optional()
    .describe('Stable identifier so the artifact can be updated later. Auto-generated when omitted.'),
  title: z.string().min(1).max(200).describe('Short human-readable title shown in the side-panel tab header.'),
  type: artifactTypeSchema.describe(
    [
      'Rendering mode:',
      '"html" — full HTML document rendered in a sandboxed iframe (scripts allowed, no same-origin).',
      '"svg" — inline SVG markup rendered in a sandboxed iframe.',
      '"react" — a self-contained React component; rendered in a sandboxed iframe with React + ReactDOM from a CDN.',
      '"markdown" — GitHub-flavoured markdown rendered with the app markdown renderer.',
      '"mermaid" — a mermaid diagram definition.',
      '"text" — plain preformatted text.',
    ].join(' '),
  ),
  content: z.string().describe('The artifact body. Must be complete and self-contained for the chosen type.'),
});

const updateInputSchema = z.object({
  id: z.string().min(1).describe('The id of an artifact previously returned by create_artifact.'),
  title: z.string().min(1).max(200).optional().describe('New title. Omit to keep the existing title.'),
  content: z.string().describe('Full replacement content for the artifact.'),
});

function generateArtifactId(): string {
  return 'art_' + Math.random().toString(36).slice(2, 10);
}

export function createArtifactTools(): ToolDefinition[] {
  const create: ToolDefinition = {
    name: 'create_artifact',
    description: [
      'Create a live-preview artifact rendered in a resizable side panel next to the chat.',
      'Use for substantial, self-contained content the user will iterate on or reference:',
      'interactive HTML demos, SVG graphics, small React components, formatted markdown documents, or mermaid diagrams.',
      'Do NOT use for short snippets, conversational answers, or content that belongs inline in the chat.',
      'Returns the artifact id — pass it to update_artifact to revise the content in place.',
    ].join(' '),
    inputSchema: createInputSchema,
    execute: async (input) => {
      const payload = input as z.infer<typeof createInputSchema>;
      const id = payload.id ?? generateArtifactId();
      // Echo the full artifact record so the renderer can upsert it without a round-trip.
      return {
        ok: true,
        action: 'create' as const,
        artifact: {
          id,
          title: payload.title,
          type: payload.type,
          content: payload.content,
          updatedAt: new Date().toISOString(),
        },
        message: `Artifact "${payload.title}" (${id}) created and opened in the side panel.`,
      };
    },
  };

  const update: ToolDefinition = {
    name: 'update_artifact',
    description: [
      'Replace the content (and optionally the title) of an existing artifact created with create_artifact.',
      'The side panel re-renders in place and keeps a version history the user can scrub through.',
      'Always send the full new content — this is a replace, not a patch.',
    ].join(' '),
    inputSchema: updateInputSchema,
    execute: async (input) => {
      const payload = input as z.infer<typeof updateInputSchema>;
      return {
        ok: true,
        action: 'update' as const,
        artifact: {
          id: payload.id,
          title: payload.title,
          content: payload.content,
          updatedAt: new Date().toISOString(),
        },
        message: `Artifact ${payload.id} updated.`,
      };
    },
  };

  return [create, update];
}
