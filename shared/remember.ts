/**
 * `/remember <line>`: Junior's own verb in the composer. The line is saved as
 * one bullet in a context file (shared/juniorContext.ts reads them at every
 * spawn): `<project>/.junior/context.md` or the workspace's `context.md`.
 *
 * Pure and browser-safe: the composer uses it to spot the verb and check the
 * line before the confirm strip, the server uses it again before it writes.
 * Nothing here touches a file.
 */
import { stripInvisible } from './juniorContext.js'

export const REMEMBER_COMMAND = 'remember'
/** A line longer than this isn't "one line" any more. */
export const REMEMBER_MAX = 500

export type RememberScope = 'project' | 'workspace'

/**
 * The text after `/remember`, when the draft is the verb: `''` for a bare
 * `/remember`, `null` when the draft is anything else (`/rememberize`, prose,
 * `/review`). Only the very start counts, like every slash command.
 */
export function rememberArg(draft: string): string | null {
  const m = /^\/remember(?:\s([\s\S]*))?$/.exec(draft.trimStart())
  return m ? (m[1] ?? '') : null
}

export type RememberCheck = { ok: true; line: string } | { ok: false; error: string; line: string }

/**
 * The line as it will be saved: invisible characters out, newlines and runs
 * of spaces folded to one space, trimmed. 1 to 500 characters.
 */
export function rememberLine(raw: unknown): RememberCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Type what Junior should remember after /remember.', line: '' }
  const line = stripInvisible(raw).text.replace(/\s+/g, ' ').trim()
  if (!line) return { ok: false, error: 'Type what Junior should remember after /remember.', line }
  if (line.length > REMEMBER_MAX) return { ok: false, error: 'Keep it to one line, under 500 characters.', line }
  return { ok: true, line }
}

/** How two lines compare: no bullet, no case, spaces folded. */
const norm = (s: string) =>
  s
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/** The file already has this line (as a bullet or a plain line). */
export function hasLine(file: string, line: string): boolean {
  const want = norm(line)
  return file.split(/\r?\n/).some((l) => norm(l) === want)
}

/**
 * The file's text with `- line` appended: on its own line, with a newline at
 * the end, and nothing else in the file touched.
 */
export function appendBullet(file: string, line: string): string {
  const head = file === '' || file.endsWith('\n') ? file : file + '\n'
  return `${head}- ${line}\n`
}

/** Where a saved line went, in the words the confirm strip uses. */
export function savedCopy(scope: RememberScope, projectName?: string): string {
  return scope === 'project' && projectName ? `Saved to ${projectName}/.junior/context.md.` : 'Saved to the workspace context.md.'
}

/** The hint under the target: which file, and when Junior reads it. */
export function pathHint(scope: RememberScope): string {
  return scope === 'project'
    ? '.junior/context.md · Junior reads it at the start of every chat.'
    : 'Workspace context.md · Junior reads it in every chat here.'
}
