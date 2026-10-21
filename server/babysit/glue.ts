/**
 * Babysitting, wired to a workspace: the `gh` source, the settings in config,
 * the repos the workspace tracks, and the minute tick. The rules are in
 * core/babysit, the tick's logic in ./watch.ts.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BABYSIT_QUERY } from '../../core/babysit/pr.js'
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

async function gh(args: string[]): Promise<string> {
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

/** Hooks the runner and notifications attach to: a task was added. */
const addedHooks: ((rt: WorkspaceRuntime, task: ItemTask, stuck: boolean) => void)[] = []
export function onTaskAdded(fn: (rt: WorkspaceRuntime, task: ItemTask, stuck: boolean) => void): void {
  addedHooks.push(fn)
}

export function babysitDeps(rt: WorkspaceRuntime): BabysitDeps {
  return {
    store: rt.store,
    source: ghBabysitSource,
    settings: () => babysitSettings(rt),
    repos: () => connectedRepos(rt),
    upsertItem: async (item) => void (await upsertItem(rt, item)),
    reviewerFor: async () => null,
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
  }
}
