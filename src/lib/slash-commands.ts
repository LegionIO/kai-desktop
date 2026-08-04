/**
 * GUI composer slash-command detection.
 *
 * The chat composer treats a few leading `/command` inputs as actions rather
 * than messages to send (mirroring the `kai` CLI's slash commands). Kept as pure
 * predicates so the matching rules are unit-tested independently of the composer
 * component's provider graph.
 */

/**
 * True when `text` is the `/compact` command (optionally with trailing args,
 * which are ignored). Requires `/compact` to be the whole first token so a
 * message merely *mentioning* `/compact` mid-sentence is still sent normally.
 */
export function isCompactCommand(text: string): boolean {
  return /^\/compact(\s|$)/.test(text.trim());
}
