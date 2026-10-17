/**
 * The actions file on disk: `<workspace>/actions.md` (core/actions/rules.ts):
 * the outbound Bash patterns and the per-tool overrides, one file.
 *
 * Seeded the way team and job templates are: written when missing, kept up
 * with the shipped default while the user hasn't touched it (a hash of what
 * triage wrote, in `.actions.seeded.json`), never overwritten once edited,
 * and not brought back after a delete. A file that doesn't parse never
 * crashes anything: the defaults stand in, and its errors ride along for the
 * Actions page to show.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_ACTIONS_FILE, DEFAULT_RULES, parseActionsFile, withOverride, type ActionRules } from '../core/actions/rules.js'

type Manifest = { version: 1; hash: string | null; removed?: boolean }

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

async function atomicWrite(file: string, text: string): Promise<void> {
  // Unique per write: two edits in flight never share (or rename away) one temp file.
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

export class ActionsFile {
  readonly path: string
  private readonly manifestPath: string
  private cache: { mtimeMs: number; rules: ActionRules; errors: string[] } | null = null
  /** last time the file's mtime was looked at. A stat per tool call is cheap, but not free */
  private checkedAt = 0

  constructor(root: string) {
    this.path = path.join(root, 'actions.md')
    this.manifestPath = path.join(root, '.actions.seeded.json')
  }

  private async manifest(): Promise<Manifest | null> {
    try {
      const m = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest
      return m && m.version === 1 ? m : null
    } catch {
      return null
    }
  }

  /** Write the default when missing (first run), or follow a newer default the user never edited. */
  async seed(): Promise<void> {
    const m = await this.manifest()
    const exists = existsSync(this.path)
    if (!exists) {
      // Seeded before and gone now = the user deleted it; the defaults apply without it.
      if (m?.hash) return
      await atomicWrite(this.path, DEFAULT_ACTIONS_FILE)
    } else {
      const text = await readFile(this.path, 'utf8')
      if (!m) {
        // A file we didn't write: the user's, from now on.
        await writeFile(this.manifestPath, JSON.stringify({ version: 1, hash: text === DEFAULT_ACTIONS_FILE ? hash(text) : null }) + '\n')
        return
      }
      if (!m.hash || hash(text) !== m.hash || text === DEFAULT_ACTIONS_FILE) return
      await atomicWrite(this.path, DEFAULT_ACTIONS_FILE)
    }
    await writeFile(this.manifestPath, JSON.stringify({ version: 1, hash: hash(DEFAULT_ACTIONS_FILE) }) + '\n')
    this.cache = null
  }

  /**
   * The rules in force, re-read when the file changes (checked at most every
   * couple of seconds). Missing file = the defaults; a broken one = the
   * defaults plus its errors.
   */
  current(): { rules: ActionRules; errors: string[] } {
    const now = Date.now()
    if (this.cache && now - this.checkedAt < 2_000) return this.cache
    this.checkedAt = now
    let mtimeMs = -1
    try {
      mtimeMs = statSync(this.path).mtimeMs
    } catch {}
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache
    if (mtimeMs < 0) {
      this.cache = { mtimeMs, rules: DEFAULT_RULES, errors: [] }
      return this.cache
    }
    // Sync on purpose: sorting happens in the event path, and the file is small.
    let text = ''
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (err) {
      this.cache = { mtimeMs, rules: DEFAULT_RULES, errors: [`could not read the file: ${err instanceof Error ? err.message : String(err)}`] }
      return this.cache
    }
    const parsed = parseActionsFile(text)
    this.cache = { mtimeMs, rules: parsed.errors.length ? DEFAULT_RULES : parsed.rules, errors: parsed.errors }
    return this.cache
  }

  /** Edits run one at a time: two quick clicks each read what the other wrote. */
  private editing: Promise<unknown> = Promise.resolve()

  /**
   * Read, change and write the file as one step, serialised with every other
   * edit (recreated from the default if it's gone).
   */
  edit(change: (text: string) => string): Promise<void> {
    const run = this.editing.then(async () => {
      const exists = existsSync(this.path)
      const text = exists ? await readFile(this.path, 'utf8') : DEFAULT_ACTIONS_FILE
      const next = change(text)
      if (next !== text || !exists) await atomicWrite(this.path, next)
      this.cache = null
    })
    this.editing = run.catch(() => {})
    return run
  }

  /** Add or remove one override entry, editing the file in place. */
  setOverride(key: 'action' | 'not_action', entry: string, add: boolean): Promise<void> {
    return this.edit((text) => withOverride(text, key, entry, add))
  }
}
