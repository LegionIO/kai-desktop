import { WORKSPACE_COLORS } from './schema.js';
import type { Workspace } from './schema.js';

/**
 * Returns the next workspace color from the palette.
 * Prefers unused colors; if all are used, cycles back to the color
 * belonging to the least-recently-active workspace.
 */
export function nextWorkspaceColor(existing: Workspace[]): string {
  const usedColors = new Set(existing.map((w) => w.color));
  const unused = WORKSPACE_COLORS.find((c) => !usedColors.has(c));
  if (unused) return unused;

  // All colors taken — pick the one used by the oldest workspace
  if (existing.length === 0) return WORKSPACE_COLORS[0];
  const sorted = [...existing].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
  return sorted[0].color;
}
