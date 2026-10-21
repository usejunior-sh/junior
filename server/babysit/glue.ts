/**
 * Babysitting, wired to a workspace: the `gh` source, the settings in config,
 * the repos the workspace tracks, and the minute tick. The rules are in
 * core/babysit, the tick's logic in ./watch.ts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BABYSIT_QUERY } from '../../core/babysit/pr.js'
import { learnedFresh, pickReviewer, REVIEWERS_KEY, REVIEWERS_QUERY, reviewersSearch, type LearnedReviewer } from '../../core/babysit/reviewer.js'
import { BABYSIT_SETTINGS_KEY, babysitSettingsFrom, type BabysitSettings } from '../../core/babysit/settings.js'
import { ghLogin } from '../../core/sources/github.js'
import type { ItemTask } from '../../core/work/tasks.js'
import { log } from '../log.js'
import { errText } from '../errors.js'
import { connectedRepos } from '../inbox/sync.js'
import { upsertItem } from '../settings-ops.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { invalidateInbox } from '../ws/send.js'
import { babysitTickOp, type BabysitDeps, type BabysitSource } from './watch.js'

const pExec = promisify(execFile)

export async function gh(args: string[]): Promise<string> {
  try {
    return (await pExec('gh', args, { maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    if (e.code === 'ENOENT') throw new Error('GitHub CLI (gh) not found')
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed${e.stderr?.trim() ? `: ${e.stderr.trim().slice(0, 300)}` : ''}`)
  }
}

export const ghBabysitSource: BabysitSource = {
  login: ghLogin,
  search: async (q, first) => JSON.parse(await gh(['api', 'graphql', '-f', `query=${BABYSIT_QUERY(first)}`, '-f', `q=${q}`])),
  failedLog: async (repo, check) => (check.runId === null ? '' : gh(['run', 'view', String(check.runId), '-R', repo, '--log-failed'])),
  rerun: async (repo, check) => {
    if (check.runId === null) throw new Error(`${check.name} isn't an Actions run`)
    await gh(['run', 'rerun', String(check.runId), '-R', repo, '--failed'])
  },
}

export async function babysitSettings(rt: WorkspaceRuntime): Promise<BabysitSettings> {
  return babysitSettingsFrom(await rt.store.config.get(BABYSIT_SETTINGS_KEY))
}

/** The reviewer Junior suggests for a repo: yours if you picked one, else learned from your merged PRs (a day's cache). */
export async function reviewerFor(rt: WorkspaceRuntime, repo: string, now = Date.now()): Promise<string | null> {
  const all = (await rt.store.config.get<Record<string, LearnedReviewer>>(REVIEWERS_KEY)) ?? {}
  const fresh = learnedFresh(all[repo], now)
  if (fresh) return fresh
  const me = await ghLogin()
  const login = pickReviewer(JSON.parse(await gh(['api', 'graphql', '-f', `query=${REVIEWERS_QUERY}`, '-f', `q=${reviewersSearch(me, repo)}`])), me)
  if (login) await rt.store.config.set(REVIEWERS_KEY, { ...all, [repo]: { login, at: now, by: 'junior' } satisfies LearnedReviewer })
  return login
}

/** You picked a reviewer for a repo: Junior suggests them from now on. */
export async function rememberReviewer(rt: WorkspaceRuntime, repo: string, login: string): Promise<void> {
  const all = (await rt.store.config.get<Record<string, LearnedReviewer>>(REVIEWERS_KEY)) ?? {}
  await rt.store.config.set(REVIEWERS_KEY, { ...all, [repo]: { login, at: Date.now(), by: 'you' } satisfies LearnedReviewer })
}

/** Hooks the runner and notifications attach to: a task was added. */
const addedHooks: ((rt: WorkspaceRuntime, task: ItemTask, stuck: boolean) => void)[] = []
export function onTaskAdded(fn: (rt: WorkspaceRuntime, task: ItemTask, stuck: boolean) => void): void {
  addedHooks.push(fn)
}

/** Hooks run after every tick: the runner's pump. */
const tickHooks: ((rt: WorkspaceRuntime) => void)[] = []
export function onBabysitTick(fn: (rt: WorkspaceRuntime) => void): void {
  tickHooks.push(fn)
}

export function babysitDeps(rt: WorkspaceRuntime): BabysitDeps {
  return {
    store: rt.store,
    source: ghBabysitSource,
    settings: () => babysitSettings(rt),
    repos: () => connectedRepos(rt),
    upsertItem: async (item) => void (await upsertItem(rt, item)),
    reviewerFor: (repo) => reviewerFor(rt, repo),
    added: (task, stuck) => {
      for (const fn of addedHooks) {
        try {
          fn(rt, task, stuck)
        } catch (err) {
          log('error', 'babysit', `task hook failed: ${errText(err)}`, { workspace: rt.meta.id })
        }
      }
    },
    log: (level, message, fields) => log(level, 'babysit', message, { ...fields, workspace: rt.meta.id }),
  }
}

/** One pass per workspace at a time. */
const ticking = new WeakSet<WorkspaceRuntime>()
export async function babysitTick(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (ticking.has(rt)) return
  ticking.add(rt)
  try {
    const r = await babysitTickOp(babysitDeps(rt), Date.now(), force)
    if (r && (r.added || r.stopped)) invalidateInbox(rt)
  } finally {
    ticking.delete(rt)
    // Queued tasks a full budget or a restart held back get their chance every tick, even when GitHub didn't answer.
    for (const fn of tickHooks) fn(rt)
  }
}
