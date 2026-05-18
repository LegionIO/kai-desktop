/**
 * Shared validation helpers for IPC handlers that read persisted JSON files.
 *
 * On-disk shapes can drift over time as field names are renamed. These helpers
 * detect old field names that should have been migrated and emit a single
 * structured warning so the user knows their JSON needs to be updated.
 */

/**
 * Warn when a persisted entity carries a deprecated field name but is missing
 * the current one. No-op when the deprecated field is absent or the current
 * field is already populated.
 *
 * @param entity         The parsed JSON object to inspect.
 * @param deprecatedKey  The legacy field name we expect to see migrated away.
 * @param expectedKey    The current field name that should hold the value.
 * @param contextLabel   Log prefix tag, e.g. `agents` or `tasks`.
 * @param entityKind     Human-readable kind of entity, e.g. `Agent` or `Task`.
 * @param id             Identifier included in the warning for traceability.
 */
export function warnOnDeprecatedField(
  entity: unknown,
  deprecatedKey: string,
  expectedKey: string,
  contextLabel: string,
  entityKind: string,
  id: string,
): void {
  if (!entity || typeof entity !== 'object') return;
  const record = entity as Record<string, unknown>;
  if (record[deprecatedKey] && !record[expectedKey]) {
    console.warn(
      `[${contextLabel}] ${entityKind} ${id} has deprecated field '${deprecatedKey}' but expected '${expectedKey}'. ` +
      `The ${entityKind.toLowerCase()} will not be properly linked. ` +
      `Please update the ${entityKind.toLowerCase()} JSON or reassign via the UI.`,
    );
  }
}
