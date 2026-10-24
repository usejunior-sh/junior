/**
 * Learnings with receipts (core/junior/learnings.ts): the folder and the ops.
 * One file per learning in `<workspace>/learnings/`. Junior proposes
 * (proposeLearningOp, from the junior MCP); you keep, edit or forget, from
 * the HTTP routes behind Junior's notebook. Nothing on Junior's side can
 * keep: keepLearningOp is the only path to `kept`, and no MCP tool calls it.
 *
 * Every write goes through one queue per folder, so two ops never read the
 * same file and write over each other. A file that doesn't parse is listed
 * as broken, never rewritten, and never used.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  edit,
  isLearningId,
  keep,
  learningId,
  markUsed,
  parseLearning,
  refProblem,
  scopeFrom,
  serializeLearning,
  sight,
  sweep,
  textProblem,
  type Learning,
  type LearningScope,
  type Sighting,
  type Sweep,
} from '../core/junior/learnings.js'
import { workspaceDir } from './workspaces.js'
import { broadcast } from './ws/send.js'
import { log } from './log.js'
import { errText } from './errors.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

export const LEARNINGS_DIR = 'learnings'

export type BrokenLearning = { id: string; file: string; errors: string[] }
export type LearningsRead = { learnings: Learning[]; broken: BrokenLearning[] }

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** The folder of one workspace's learnings. Pure file work; the ops add logging and broadcasts. */
export class LearningsFolder {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(readonly dir: string) {}

  pathOf(id: string): string {
    return path.join(this.dir, `${id}.md`)
  }

  /** Every learning in the folder, plus the files that didn't parse. A missing folder is an empty one. */
  async read(): Promise<LearningsRead> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch {
      return { learnings: [], broken: [] }
    }
    const learnings: Learning[] = []
    const broken: BrokenLearning[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const id = name.slice(0, -3)
      const file = path.join(this.dir, name)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (err) {
        broken.push({ id, file, errors: [`could not read: ${errText(err)}`] })
        continue
      }
      const parsed = parseLearning(id, text)
      if (parsed.learning) learnings.push(parsed.learning)
      else broken.push({ id, file, errors: parsed.errors })
    }
    return { learnings, broken }
  }

  /** Run `fn` after every earlier write here has finished. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.catch(() => {})
    return run
  }

  async write(l: Learning): Promise<void> {
    if (!isLearningId(l.id)) throw new Error(`bad learning id: ${l.id}`)
    await mkdir(this.dir, { recursive: true })
    await atomicWrite(this.pathOf(l.id), serializeLearning(l))
  }

  async remove(id: string): Promise<void> {
    if (!isLearningId(id)) throw new Error(`bad learning id: ${id}`)
    await rm(this.pathOf(id), { force: true })
  }

  /** One read, one change, one write, in turn with every other change here. */
  update<T>(fn: (read: LearningsRead) => Promise<T>): Promise<T> {
    return this.serial(async () => fn(await this.read()))
  }

  // The moves. Each throws a plain sentence when it can't.

  propose(input: { text: unknown; scope: unknown; ref: unknown }, now: number): Promise<Sighting> {
    const bad = textProblem(input.text) ?? refProblem(input.ref)
    if (bad) return Promise.reject(new Error(bad))
    const scope = scopeFrom(input.scope)
    if (!scope) return Promise.reject(new Error('scope: global, or repo:<owner>/<repo>'))
    return this.update(async ({ learnings, broken }) => {
      const taken = new Set([...learnings.map((l) => l.id), ...broken.map((b) => b.id)])
      const s = sight(learnings, { text: input.text as string, scope, ref: input.ref as string }, now, () => learningId(input.text as string, taken))
      await this.write(s.learning)
      return s
    })
  }

  keep(id: string, now: number): Promise<Learning> {
    return this.update(async ({ learnings }) => {
      const before = learnings.find((l) => l.id === id)
      const m = keep(learnings, id, now)
      if (!m.ok) throw new Error(m.error)
      if (m.learning !== before) await this.write(m.learning)
      return m.learning
    })
  }

  edit(id: string, input: { text?: string; scope?: LearningScope; confirm?: boolean }): Promise<Learning> {
    return this.update(async ({ learnings }) => {
      const m = edit(learnings, id, input)
      if (!m.ok) throw new Error(m.error)
      await this.write(m.learning)
      return m.learning
    })
  }

  forget(id: string): Promise<Learning> {
    return this.update(async ({ learnings }) => {
      const l = learnings.find((x) => x.id === id)
      if (!l) throw new Error('no such learning')
      await this.remove(id)
      return l
    })
  }

  markUsed(ids: readonly string[], now: number): Promise<Learning[]> {
    if (!ids.length) return Promise.resolve([])
    return this.update(async ({ learnings }) => {
      const changed = markUsed(learnings, ids, now)
      for (const l of changed) await this.write(l)
      return changed
    })
  }

  sweep(now: number): Promise<Sweep> {
    return this.update(async ({ learnings }) => {
      const s = sweep(learnings, now)
      for (const l of s.expired) await this.remove(l.id)
      return s
    })
  }
}

// ---------------------------------------------------------------------------
// Per workspace

const folders = new Map<string, LearningsFolder>()

/** The workspace's learnings folder: one instance per workspace, so its write queue is shared. */
export function learningsFolder(rt: WorkspaceRuntime): LearningsFolder {
  const dir = path.join(workspaceDir(rt.meta.id), LEARNINGS_DIR)
  let f = folders.get(dir)
  if (!f) folders.set(dir, (f = new LearningsFolder(dir)))
  return f
}

const changed = (rt: WorkspaceRuntime) => broadcast(rt, { type: 'learnings_changed' })

const idOf = (raw: unknown): string => {
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id.trim() : ''
  if (!isLearningId(id)) throw new Error('need the id of a learning')
  return id
}

export type LearningsList = LearningsRead & { path: string }

/**
 * What Junior's notebook lists: proposed and kept learnings, newest first,
 * and the files that didn't parse. Candidates are Junior's quiet notes and
 * stay out unless `all` is asked for.
 */
export async function listLearningsOp(rt: WorkspaceRuntime, opts: { all?: boolean } = {}): Promise<LearningsList> {
  const f = learningsFolder(rt)
  const { learnings, broken } = await f.read()
  const shown = (opts.all ? learnings : learnings.filter((l) => l.status !== 'candidate')).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  return { learnings: shown, broken, path: f.dir }
}

/**
 * Junior saw something worth learning, with a receipt. The first sighting is
 * a quiet candidate; a matching one on another day becomes a proposal. Never
 * keeps. (The propose_learning tool, its daily cap and the proposal card are
 * the next plan item, learnings-propose-tool.)
 */
export async function proposeLearningOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<Sighting> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const s = await learningsFolder(rt).propose({ text: r.text, scope: r.scope ?? 'global', ref: r.source ?? r.ref }, now)
  log('info', 'learnings', `${s.kind}: ${s.learning.text.slice(0, 80)}`, { learning: s.learning.id, workspace: rt.meta.id })
  if (s.kind !== 'candidate') changed(rt)
  return s
}

/** You said keep. The only way a learning becomes `kept`. */
export async function keepLearningOp(rt: WorkspaceRuntime, raw: unknown, now = Date.now()): Promise<Learning> {
  const l = await learningsFolder(rt).keep(idOf(raw), now)
  log('info', 'learnings', `kept: ${l.text.slice(0, 80)}`, { learning: l.id, workspace: rt.meta.id })
  changed(rt)
  return l
}

/** You changed its words or scope. `confirm` lets an edit cut more than half. */
export async function editLearningOp(rt: WorkspaceRuntime, raw: unknown): Promise<Learning> {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const id = idOf(r)
  const input: { text?: string; scope?: LearningScope; confirm?: boolean } = { confirm: r.confirm === true }
  if (r.text !== undefined) {
    if (typeof r.text !== 'string') throw new Error('text is a string')
    input.text = r.text
  }
  if (r.scope !== undefined) {
    const scope = scopeFrom(r.scope)
    if (!scope) throw new Error('scope: global, or repo:<owner>/<repo>')
    input.scope = scope
  }
  if (input.text === undefined && input.scope === undefined) throw new Error('nothing to change: send text or scope')
  const l = await learningsFolder(rt).edit(id, input)
  log('info', 'learnings', `edited: ${l.text.slice(0, 80)}`, { learning: l.id, workspace: rt.meta.id })
  changed(rt)
  return l
}

/** You said forget (or Undo on a proposal). The file goes. */
export async function forgetLearningOp(rt: WorkspaceRuntime, raw: unknown): Promise<Learning> {
  const l = await learningsFolder(rt).forget(idOf(raw))
  log('info', 'learnings', `forgot: ${l.text.slice(0, 80)}`, { learning: l.id, workspace: rt.meta.id })
  changed(rt)
  return l
}

/** Kept learnings went into a chat or run: they stay fresh. Never throws. */
export async function markLearningsUsed(rt: WorkspaceRuntime, ids: readonly string[], now = Date.now()): Promise<void> {
  try {
    if ((await learningsFolder(rt).markUsed(ids, now)).length) changed(rt)
  } catch (err) {
    log('warn', 'learnings', `could not mark learnings used: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** How often the expiry sweep looks, per workspace. */
export const SWEEP_EVERY_MS = 6 * 3_600_000
const lastSweep = new Map<string, number>()

/**
 * The expiry sweep, from the minute tick but at most every SWEEP_EVERY_MS.
 * Unused for 28 days, a learning goes, unless the loss guard holds the kept
 * ones (more than half of them at once). Never throws.
 */
export async function sweepLearningsTick(rt: WorkspaceRuntime, now = Date.now()): Promise<void> {
  const last = lastSweep.get(rt.meta.id) ?? 0
  if (now - last < SWEEP_EVERY_MS) return
  lastSweep.set(rt.meta.id, now)
  try {
    const s = await learningsFolder(rt).sweep(now)
    for (const l of s.expired) log('info', 'learnings', `expired, unused for 28 days: ${l.text.slice(0, 80)}`, { learning: l.id, status: l.status, workspace: rt.meta.id })
    if (s.held.length) {
      log('warn', 'learnings', `kept ${s.held.length} unused learning(s): letting them go would drop more than half of what you kept`, { ids: s.held.map((l) => l.id), workspace: rt.meta.id })
    }
    if (s.expired.some((l) => l.status !== 'candidate')) changed(rt)
  } catch (err) {
    log('warn', 'learnings', `expiry sweep failed: ${errText(err)}`, { workspace: rt.meta.id })
  }
}
