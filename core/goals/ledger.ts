/**
 * A goal's ledger files in the workspace artifacts repo:
 *
 *   artifacts/goals/<goal-id>/
 *     plan.md      the plan (source of truth for it; the DB caches it parsed)
 *     log.md       append-only, one entry per session, rolled
 *                  over to log-001.md, log-002.md… past LOG_ROLLOVER_BYTES
 *     handoff.md   rewritten by each session: done, next, watch out for
 *
 * Every write that changes a file commits only the goal's own folder
 * (`git add -- goals/<id>` and a pathspec commit), so whatever
 * else is dirty or staged in the artifacts repo never rides along. A failed
 * commit leaves the file written, the DB is the source of truth for state,
 * and the next write's commit picks the change up. After
 * LEDGER_COMMIT_WARN_AFTER failures in a row the goal page shows a warning.
 *
 * Writes are idempotent: a file is only written when its text would change,
 * and a log entry repeated with the same content is found by its marker and
 * not appended again.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { goalDir, LEDGER_COMMIT_WARN_AFTER, LOG_ROLLOVER_BYTES, type SessionOutcome, type StepRole } from './types.js'

const pExecFile = promisify(execFile)

/** One entry as goal_log_append hands it in. */
export type LogEntryInput = {
  sessionId: string
  stepId: string | null
  role: StepRole
  outcome: SessionOutcome | null
  text: string
  commits: string[]
  files: string[]
  commands: { cmd: string; ok: boolean }[]
}

export type HandoffInput = { sessionId: string; done: string; next: string; watchOut: string | null }

/** appended = a new entry; revised = this session+step had an entry with other content, so a revision follows it; unchanged = nothing written. */
export type AppendOutcome = 'appended' | 'revised' | 'unchanged'

const MARKER_RE = /^<!-- goal-log session=(\S+) step=(\S+) hash=([0-9a-f]+) -->$/gm

/** Ids go into a marker and a folder name: keep them to safe characters. */
export const isLedgerId = (s: string) => /^[\w.:-]{1,120}$/.test(s)

function entryHash(e: LogEntryInput): string {
  const h = createHash('sha256')
  h.update(JSON.stringify([e.role, e.outcome, e.text.trim(), e.commits, e.files, e.commands]))
  return h.digest('hex').slice(0, 16)
}

/** The markdown section for one entry. `at` is the first time it was written; a repeat with the same content isn't written at all. */
export function renderLogEntry(e: LogEntryInput, at: number, revised: boolean): string {
  const head = [new Date(at).toISOString(), e.role, e.stepId ? `step ${e.stepId}` : null, e.outcome, revised ? 'revised' : null].filter(Boolean).join(' · ')
  const out = [`<!-- goal-log session=${e.sessionId} step=${e.stepId ?? '-'} hash=${entryHash(e)} -->`, `## ${head}`, '', `Session \`${e.sessionId}\``, '', e.text.trim(), '']
  if (e.commits.length) out.push(`**Commits:** ${e.commits.map((c) => `\`${c}\``).join(', ')}`, '')
  if (e.files.length) out.push('**Files:**', ...e.files.map((f) => `- \`${f}\``), '')
  if (e.commands.length) out.push('**Commands:**', ...e.commands.map((c) => `- ${c.ok ? '✓' : '✗'} \`${c.cmd}\``), '')
  return out.join('\n') + '\n'
}

/** handoff.md for what a session handed over. Deterministic, so writing the same handoff again changes nothing. */
export function renderHandoff(h: HandoffInput): string {
  const out = ['# Handoff', '', `From session \`${h.sessionId}\`.`, '', '## Done', '', h.done.trim(), '', '## Next', '', h.next.trim(), '']
  if (h.watchOut?.trim()) out.push('## Watch out for', '', h.watchOut.trim(), '')
  return out.join('\n')
}

/** The log's entries, oldest first, each starting at its marker. Text before the first marker is dropped. */
export function splitLog(md: string): string[] {
  const starts = [...md.matchAll(MARKER_RE)].map((m) => m.index!)
  return starts.map((s, i) => md.slice(s, starts[i + 1] ?? md.length))
}

/** The last marker hash for a session+step in a log, or null. */
function lastHash(md: string, sessionId: string, stepId: string): string | null {
  let found: string | null = null
  for (const m of md.matchAll(MARKER_RE)) if (m[1] === sessionId && m[2] === stepId) found = m[3]!
  return found
}

export type LedgerFiles = { plan: string; handoff: string; log: string }

export class GoalLedger {
  /** goal id → commits failed in a row */
  private readonly failures = new Map<string, number>()
  /** goal id → the tail of its write chain, so two writes to one goal never interleave */
  private readonly chains = new Map<string, Promise<unknown>>()

  /** `root` is the workspace's artifacts folder (its git repo). */
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  private dir(goalId: string): string {
    if (!isLedgerId(goalId)) throw new Error(`invalid goal id "${goalId}"`)
    return path.join(this.root, ...goalDir(goalId).split('/'))
  }

  private serial<T>(goalId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(goalId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.chains.set(
      goalId,
      next.catch(() => {}),
    )
    return next
  }

  private async readText(file: string): Promise<string> {
    try {
      return await readFile(file, 'utf8')
    } catch {
      return ''
    }
  }

  /** Write `text` to a ledger file when it differs. True = written. */
  private async put(goalId: string, name: string, text: string): Promise<boolean> {
    const dir = this.dir(goalId)
    const file = path.join(dir, name)
    if ((await this.readText(file)) === text) return false
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, file)
    return true
  }

  /**
   * Commit the goal's folder, and only it. Nothing to commit is not a
   * failure; no git repo means there is no history to keep, not an error.
   */
  async commit(goalId: string, message: string): Promise<void> {
    if (!existsSync(path.join(this.root, '.git'))) return
    const rel = goalDir(goalId)
    const git = (args: string[]) => pExecFile('git', ['-c', 'user.name=junior', '-c', 'user.email=junior@localhost', ...args], { cwd: this.root })
    try {
      await git(['add', '-A', '--', rel])
      const { stdout } = await git(['diff', '--cached', '--name-only', '--', rel])
      if (!stdout.trim()) {
        this.failures.delete(goalId)
        return
      }
      await git(['commit', '-q', '-m', message, '--', rel])
      this.failures.delete(goalId)
    } catch {
      this.failures.set(goalId, (this.failures.get(goalId) ?? 0) + 1)
    }
  }

  /** Set after repeated commit failures, else null. */
  warning(goalId: string): string | null {
    const n = this.failures.get(goalId) ?? 0
    return n >= LEDGER_COMMIT_WARN_AFTER ? `The ledger's last ${n} commits failed. The files are written; their history isn't being kept until git works again.` : null
  }

  /** Write plan.md. True = it changed (and was committed). */
  writePlan(goalId: string, md: string, version: number): Promise<boolean> {
    return this.serial(goalId, async () => {
      const changed = await this.put(goalId, 'plan.md', md)
      if (changed) await this.commit(goalId, `goal ${goalId}: plan v${version}`)
      return changed
    })
  }

  /** Rewrite handoff.md. True = it changed. */
  writeHandoff(goalId: string, h: HandoffInput): Promise<boolean> {
    return this.serial(goalId, async () => {
      const changed = await this.put(goalId, 'handoff.md', renderHandoff(h))
      if (changed) await this.commit(goalId, `goal ${goalId}: handoff from ${h.sessionId}`)
      return changed
    })
  }

  /** Rewrite handoff.md with the user's own text, as they edited it on the goal page. True = it changed. */
  writeHandoffText(goalId: string, text: string, by: string): Promise<boolean> {
    return this.serial(goalId, async () => {
      const changed = await this.put(goalId, 'handoff.md', text.endsWith('\n') ? text : `${text}\n`)
      if (changed) await this.commit(goalId, `goal ${goalId}: handoff edited by ${by}`)
      return changed
    })
  }

  /** Append a session's entry to log.md, unless the same entry is already its latest. */
  appendLog(goalId: string, e: LogEntryInput): Promise<AppendOutcome> {
    return this.serial(goalId, async () => {
      const dir = this.dir(goalId)
      const file = path.join(dir, 'log.md')
      let current = await this.readText(file)
      const step = e.stepId ?? '-'
      // The latest entry for this key may sit in the file the log just rolled into.
      const prior = lastHash(current, e.sessionId, step) ?? lastHash(await this.readText(await this.lastRolled(dir)), e.sessionId, step)
      if (prior === entryHash(e)) return 'unchanged'
      await mkdir(dir, { recursive: true })
      if (current && Buffer.byteLength(current) > LOG_ROLLOVER_BYTES) {
        await rename(file, path.join(dir, await this.nextRolledName(dir)))
        current = ''
      }
      const entry = renderLogEntry(e, this.now(), prior !== null)
      await writeFile(file, current ? `${current.replace(/\n*$/, '\n')}\n${entry}` : `# Log\n\n${entry}`, 'utf8')
      await this.commit(goalId, `goal ${goalId}: log ${e.sessionId}`)
      return prior === null ? 'appended' : 'revised'
    })
  }

  private async rolled(dir: string): Promise<string[]> {
    try {
      return (await readdir(dir)).filter((f) => /^log-\d{3,}\.md$/.test(f)).sort()
    } catch {
      return []
    }
  }

  private async lastRolled(dir: string): Promise<string> {
    const all = await this.rolled(dir)
    return all.length ? path.join(dir, all[all.length - 1]!) : path.join(dir, 'log-000.md')
  }

  private async nextRolledName(dir: string): Promise<string> {
    const all = await this.rolled(dir)
    const last = all.length ? Number(/^log-(\d+)\.md$/.exec(all[all.length - 1]!)![1]) : 0
    return `log-${String(last + 1).padStart(3, '0')}.md`
  }

  /** The three files as text ('' when not written yet); `logEntries` = how many of the latest log entries to return. */
  async read(goalId: string, logEntries: number): Promise<LedgerFiles> {
    const dir = this.dir(goalId)
    const [plan, handoff, log] = await Promise.all(['plan.md', 'handoff.md', 'log.md'].map((f) => this.readText(path.join(dir, f))))
    const entries = splitLog(log!)
    return { plan: plan!, handoff: handoff!, log: entries.slice(-logEntries).join('') }
  }
}
