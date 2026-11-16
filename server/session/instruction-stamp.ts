/**
 * The instruction files a chat reads once, at spawn, and keeps for its
 * process's whole life: every CLAUDE.md Claude Code loads (managed, user, each
 * folder from the session's up to /, their `.claude/rules`) and Junior's own
 * context files. A stamp of them is taken at spawn and compared before each
 * message (getOrRevive in sessions.ts): when one changed, the chat resumes in
 * a new process that reads it, so an edit lands on the next message.
 *
 * Only node imports, so the test reads real files without a workspace.
 * `@path` imports inside a CLAUDE.md are not followed.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

/** path → hash of its contents, for each file that exists. */
export type InstructionStamp = Map<string, string>

const MANAGED_CLAUDE_MD = '/Library/Application Support/ClaudeCode/CLAUDE.md'

/** Where Claude Code looks for CLAUDE.md for a session in `cwd`: files to read, and rules folders to walk. */
export function claudeMdPlaces(cwd: string, configDir: string): { files: string[]; ruleDirs: string[] } {
  const files = [MANAGED_CLAUDE_MD, path.join(configDir, 'CLAUDE.md')]
  const ruleDirs = [path.join(configDir, 'rules')]
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    files.push(path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md'), path.join(dir, 'CLAUDE.local.md'))
    ruleDirs.push(path.join(dir, '.claude', 'rules'))
    if (path.dirname(dir) === dir) break
  }
  return { files, ruleDirs }
}

async function hashOf(file: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(file)).digest('hex')
  } catch {
    return null // missing, a folder, or unreadable: not part of the stamp
  }
}

async function rulesIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { recursive: true })
    return names.filter((n) => n.endsWith('.md')).map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

/** A stamp of whichever of these files exist now. Contents, not mtimes: a save with no edit changes nothing. */
export async function stampOf(files: string[], ruleDirs: string[] = []): Promise<InstructionStamp> {
  const all = [...new Set([...files, ...(await Promise.all(ruleDirs.map(rulesIn))).flat()])]
  const hashes = await Promise.all(all.map(hashOf))
  const stamp: InstructionStamp = new Map()
  all.forEach((file, i) => {
    const h = hashes[i]
    if (h) stamp.set(file, h)
  })
  return stamp
}

/** The files that differ between two stamps: edited, added or removed. */
export function changedFiles(before: InstructionStamp, after: InstructionStamp): string[] {
  const out: string[] = []
  for (const [file, h] of after) if (before.get(file) !== h) out.push(file)
  for (const file of before.keys()) if (!after.has(file)) out.push(file)
  return out
}
