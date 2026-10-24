/**
 * Babysitting, wired to a workspace: the `gh` source, the settings in config,
 * the repos the workspace tracks, the minute tick, and the one-time carry-over
 * of the PRs Junior was already working when hand-offs came in. The rules are in
 * core/babysit, the tick's logic in ./watch.ts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BABYSIT_QUERY } from '../../core/babysit/pr.js'
import { mainRunsFrom } from '../../core/babysit/ci-sort.js'
import { chosenReviewer, learnedFresh, pickReviewer, REVIEWERS_KEY, REVIEWERS_QUERY, reviewersSearch, type LearnedReviewer } from '../../core/babysit/reviewer.js'
import { BABYSIT_SETTINGS_KEY, babysitSettingsFrom, type BabysitSettings } from '../../core/babysit/settings.js'
import { ghLogin } from '../../core/sources/github.js'
import { reasonOf } from '../../core/work/fields.js'
import { legacyHandoffs } from '../../core/work/handoff.js'
import { log } from '../log.js'
import { connectedRepos } from '../inbox/sync.js'
import { upsertItem, watchesOn } from '../settings-ops.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { invalidateInbox } from '../ws/send.js'
import { babysitTickOp, type BabysitDeps, type BabysitSource } from './watch.js'
import { reviewersFor, type RepoContract } from '../../core/work/contract.js'
import { readRepoContract } from '../repo-contract.js'
import { runTickHooks, taskAdded } from './hooks.js'

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
  // one page of 100 is enough: the sort only reads each check's latest completed run
  mainRuns: async (repo, branch) => mainRunsFrom(JSON.parse(await gh(['api', `repos/${repo}/commits/${encodeURIComponent(branch)}/check-runs?per_page=100`]))),
  rerun: async (repo, check) => {
    if (check.runId === null) throw new Error(`${check.name} isn't an Actions run`)
    await gh(['run', 'rerun', String(check.runId), '-R', repo, '--failed'])
  },
}

export async function babysitSettings(rt: WorkspaceRuntime): Promise<BabysitSettings> {
  return babysitSettingsFrom(await rt.store.config.get(BABYSIT_SETTINGS_KEY))
}

/**
 * The repo's .junior/junior.md contract, read from the project folder that
 * holds it (the user's checkout: what's on its branch now). null when no
 * project holds the repo or the file isn't there.
 */
export async function contractForRepo(rt: WorkspaceRuntime, repo: string): Promise<RepoContract | null> {
  const project = (await rt.store.projects.list()).find((p) => p.repo === repo)
  if (!project) return null
  const loaded = await readRepoContract(project.path)
  return loaded.found ? loaded.contract : null
}

/** The paths a PR changes, by `gh pr view`. [] when it can't be read. */
async function prPaths(repo: string, number: number): Promise<string[]> {
  try {
    const v = JSON.parse(await gh(['pr', 'view', String(number), '-R', repo, '--json', 'files'])) as { files?: { path?: unknown }[] }
    return (v.files ?? []).map((f) => (typeof f.path === 'string' ? f.path : '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The reviewer Junior suggests for a PR: yours if you picked one, else the
 * repo's .junior/ reviewers for the paths it changed, else learned from your
 * merged PRs (a day's cache).
 */
export async function reviewerFor(rt: WorkspaceRuntime, repo: string, pr?: { number: number }, now = Date.now()): Promise<string | null> {
  const all = (await rt.store.config.get<Record<string, LearnedReviewer>>(REVIEWERS_KEY)) ?? {}
  if (all[repo]?.by === 'you') return all[repo].login
  const contract = pr ? await contractForRepo(rt, repo).catch(() => null) : null
  if (pr && contract?.reviewers.length) {
    const me = await ghLogin()
    const picked = chosenReviewer(all[repo], reviewersFor(contract, await prPaths(repo, pr.number)), me)
    if (picked) return picked
  }
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

// The hooks live in a leaf (./hooks.ts) so the runner can register them whichever module loads first.
export { onBabysitTick, onTaskAdded, runTickHooks, taskAdded } from './hooks.js'

export function babysitDeps(rt: WorkspaceRuntime): BabysitDeps {
  return {
    store: rt.store,
    source: ghBabysitSource,
    repos: () => connectedRepos(rt),
    upsertItem: async (item) => void (await upsertItem(rt, item)),
    reviewerFor: (repo, pr) => reviewerFor(rt, repo, pr),
    contractFor: (repo) => contractForRepo(rt, repo),
    graceMinutes: async () => (await babysitSettings(rt)).graceMinutes,
    added: (task, stuck) => taskAdded(rt, task, stuck),
    log: (level, message, fields) => log(level, 'babysit', message, { ...fields, workspace: rt.meta.id }),
  }
}

/** Set once the carry-over ran: it never runs twice. */
const CARRIED_KEY = 'handoff.carried'

/**
 * Hand-offs came in: the PRs Junior was already working under the old
 * switches (babysit on, first-pass reviews on) stay handed off. Once.
 */
export async function carryOverHandoffs(rt: WorkspaceRuntime): Promise<void> {
  if (await rt.store.config.get(CARRIED_KEY)) return
  const raw = ((await rt.store.config.get<Record<string, unknown>>(BABYSIT_SETTINGS_KEY)) ?? {}) as { enabled?: unknown; reviews?: unknown }
  const was = { babysit: raw.enabled === true, reviews: raw.reviews === true }
  if (was.babysit || was.reviews) {
    const items = (await rt.store.items.list('open')).map((i) => ({ id: i.id, reason: reasonOf(i), ...(i.handoff ? { handoff: i.handoff } : {}) }))
    const ids = legacyHandoffs(items, await rt.store.tasks.forItems(items.map((i) => i.id)), was)
    for (const id of ids) await rt.store.items.setFields(id, { handoff: 'on' })
    if (ids.length) log('info', 'babysit', `kept ${ids.length} PR(s) Junior was already working handed off`, { ids, workspace: rt.meta.id })
  }
  await rt.store.config.set(CARRIED_KEY, { at: Date.now() })
}

/** One pass per workspace at a time. */
const ticking = new WeakSet<WorkspaceRuntime>()
export async function babysitTick(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (ticking.has(rt)) return
  ticking.add(rt)
  try {
    await carryOverHandoffs(rt)
    // Switched off here: no polling, no new tasks. The queued ones wait (pumpOnce).
    if (!(await watchesOn(rt)).babysit) return
    const r = await babysitTickOp(babysitDeps(rt), Date.now(), force)
    if (r && (r.added || r.stopped)) invalidateInbox(rt)
  } finally {
    ticking.delete(rt)
    // Queued tasks a full budget or a restart held back get their chance every tick, even when GitHub didn't answer.
    runTickHooks(rt)
  }
}
