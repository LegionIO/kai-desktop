/**
 * Routing helper: should this tool-call render with the specialized
 * `SubAgentInline` card (live nested thread, status, Open/stop controls) rather
 * than the generic tool card?
 *
 * A sub-agent tool-call may reach the renderer with its `toolName` briefly
 * missing/unknown (a streamed tool-call event whose name lands after the first
 * render), especially under parallel sub-agent spawns. So in addition to the
 * name, we route when a `resolvedSubAgentId` is present. That id MUST come from a
 * TRUSTED backend binding (the caller passes `liveOutput.subAgentConversationId`,
 * which the renderer's progress binding sets onto THIS tool-call from backend
 * tool-progress — bound per-child, immune to execute/stream id divergence and to
 * parallel spawns). The caller must NOT pass an id sourced from arbitrary tool
 * RESULT content: a result is tool-produced, so trusting it would let an
 * unrelated tool emit a child's id and hijack that child's navigate/message/stop
 * controls.
 *
 * SECURITY: a KNOWN non-`sub_agent` tool name is authoritative and always renders
 * as a generic card — a stray `subAgentConversationId` can never promote it to a
 * sub-agent card.
 */
export function isSubAgentToolCall(
  toolName: string | undefined,
  resolvedSubAgentId?: string | null,
): boolean {
  if (toolName === 'sub_agent') return true;
  const nameKnownNonSubAgent = typeof toolName === 'string' && toolName.length > 0 && toolName !== 'unknown';
  if (nameKnownNonSubAgent) return false;
  return Boolean(resolvedSubAgentId);
}
