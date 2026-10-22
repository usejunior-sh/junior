/**
 * Session names: the handle `/rename` sets, and how one session addresses
 * another (start_session / message_session). Pure, so the rules are tested
 * without a store.
 *
 * A name is the same thing Claude Code calls a session's name, so it reads
 * like one: any short line of text ("auth fix", "Docs pass"). Unique in the
 * workspace, compared without case (the store's index is NOCASE too).
 */

export const MAX_NAME_LENGTH = 60

/** A cleaned name, or why the text can't be one. */
export function cleanSessionName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) return { ok: false, error: 'a session name cannot be empty' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, error: `a session name is at most ${MAX_NAME_LENGTH} characters` }
  return { ok: true, name }
}

/** Do two names address the same session? */
export const sameName = (a: string | null | undefined, b: string): boolean =>
  !!a && a.toLowerCase() === b.toLowerCase()

/**
 * `/rename <name>` typed in a chat: the new name, '' for a bare `/rename`
 * (which clears it), or null when the message isn't the command at all.
 */
export function renameCommand(text: string): string | null {
  const m = /^\/rename(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  return (m[1] ?? '').trim()
}
