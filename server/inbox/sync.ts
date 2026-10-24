import { fetchGitHub, fetchGitHubClosed, listAffiliatedRepos } from '../../core/sources/github.js'
import { log } from '../log.js'
import { taskSummary } from '../../core/work/tasks.js'
import { withJunior } from './junior.js'
import { withSupervision } from '../supervision-ops.js'
import type { InboxSnapshot } from '../../shared/protocol.js'
import { buildInbox } from '../../core/work/inbox.js'
import { startOfDay } from '../../core/work/due.js'
import { ARCHIVE_AFTER_DAYS, shouldArchive } from '../../core/work/fade.js'
import type { ItemStatus } from '../../core/work/state.js'
import { linkByRefs } from '../../core/work/link.js'
import { rank } from '../../core/work/score.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { jobsEnabled, readScoreWeights, upsertItem } from '../settings-ops.js'
import { overdueJobs } from '../jobs/scheduler.js'
import { inboxAlerts, withFlows } from './flow.js'
import { recordSurfaced } from '../attention-ops.js'
import { errText } from '../errors.js'

// Inbox: ranked work items from deterministic sources (core/work). No cron:
// the server IS the long-running process. Sync happens when the page is
// viewed and the cache is stale (stale-while-revalidate, the cache living in
// SQLite so a fresh server start still renders instantly), on explicit
// Refresh, and on a keep-warm interval while the server runs. A laptop that
// slept through the interval simply syncs on the next view.
const INBOX_TTL_MS = 5 * 60_000
export const INBOX_KEEP_WARM_MS = 15 * 60_000

const GITHUB_TTL_MS = 5 * 60_000
const GITHUB_LOOKBACK_MS = 14 * 86_400_000

export const REPOS_KEY = 'github.repos'

export async function connectedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  return (await rt.store.config.get<string[]>(REPOS_KEY)) ?? []
}

/** Is the claude.ai Slack connector connected, per the last connector probe? */
export function slackConnected(rt: WorkspaceRuntime): boolean | null {
  if (!rt.connectorCache) return null // no probe yet
  return rt.connectorCache.connectors.some(
    (c) => c.source === 'claude.ai' && c.name === 'Slack' && c.status === 'connected',
  )
}

/**
 * GitHub reconciliation (.docs/jobs-v2.md). GitHub is a deterministic source,
 * not an LLM scan, so it stays plain code, but it now writes into the SAME
 * durable store as everything else instead of being refetched-and-discarded
 * every view. Open PRs/issues are upserted (idempotent, newer-wins); a tracked
 * open item whose PR has since merged or closed is auto-done with actor:system
 * and evidence, recorded and reversible, never a silent vanish. Throttled; a
 * failure degrades to a notice and keeps whatever is already stored.
 */
export async function reconcileGitHub(rt: WorkspaceRuntime, force = false): Promise<void> {
  if (rt.githubReconcileInFlight) return rt.githubReconcileInFlight
  if (!force && Date.now() - rt.githubReconcileAt < GITHUB_TTL_MS) return
  rt.githubReconcileInFlight = (async () => {
    try {
      const repos = await connectedRepos(rt)
      // Workspace isolation (.docs/workspaces.md): repo scope is per-workspace,
      // and an empty scope means NO GitHub items, not the whole account. An
      // account-wide search would mirror the same PRs into every workspace's
      // inbox, which is exactly the cross-workspace bleed workspaces exist to
      // prevent. You opt each workspace into the repos it should track.
      if (repos.length === 0) {
        rt.githubNotice = null
        rt.githubReconcileAt = Date.now()
        return
      }
      const now = Date.now()
      const open = await fetchGitHub(repos, now)
      for (const item of open) await upsertItem(rt, item)

      // Source-side completion: any tracked open/snoozed github item whose PR is
      // now merged/closed → done(system) with evidence.
      const closed = await fetchGitHubClosed(repos, new Date(now - GITHUB_LOOKBACK_MS).toISOString())
      if (closed.length > 0) {
        const byId = new Map(closed.map((c) => [c.id, c]))
        for (const it of await rt.store.items.listAll()) {
          if (it.source !== 'github') continue
          if (it.status !== 'open' && it.status !== 'snoozed') continue
          const c = byId.get(it.id)
          if (c) {
            const reason = c.state === 'merged' ? 'PR merged' : 'PR closed'
            await rt.store.items.transition(it.id, {
              status: 'done',
              actor: 'system',
              detail: { reason, evidence: c.url },
            })
            log('info', 'github', `auto-done: ${it.id} (${reason})`, { id: it.id, state: c.state, workspace: rt.meta.id })
          }
        }
      }
      rt.githubNotice = null
      rt.githubReconcileAt = Date.now()
      log('info', 'github', `reconciled: ${open.length} open, ${closed.length} closed/merged`, { workspace: rt.meta.id })
    } catch (err) {
      rt.githubNotice = `github: ${err instanceof Error ? err.message : String(err)}`
      log('error', 'github', err instanceof Error ? err.message : String(err), { workspace: rt.meta.id })
    } finally {
      rt.githubReconcileInFlight = null
    }
  })()
  return rt.githubReconcileInFlight
}

/**
 * Rebuild the open-inbox snapshot from the durable store: wake elapsed snoozes,
 * reconcile GitHub (throttled), then rank + link the open items. There is no
 * user-state overlay any more, status lives on each row, so this is a pure
 * fold over what the store already holds.
 */
export function syncInbox(rt: WorkspaceRuntime): Promise<InboxSnapshot> {
  if (rt.inboxInFlight) return rt.inboxInFlight
  rt.inboxInFlight = (async () => {
    try {
      const now = Date.now()
      await rt.store.items.wakeSnoozed(now)
      await fadeOldFyi(rt, now)
      await reconcileGitHub(rt)
      const scoped = new Set(await connectedRepos(rt))
      const items = scopeGitHub(await rt.store.items.list('open'), scoped)
      const notices: string[] = []
      if (rt.githubNotice) notices.push(rt.githubNotice)
      // Honest empty state: a workspace with no repos scoped pulls no GitHub.
      // Say so, so "nothing here" is never mistaken for "the source is broken".
      if (scoped.size === 0) {
        notices.push('github: no repos scoped to this workspace — pick repos in the inbox’s repo filter to pull PRs and issues here')
      }
      if (slackConnected(rt) === false) {
        notices.push('slack: the claude.ai Slack connector is disconnected — reconnect it for Slack items to appear')
      } else if (slackConnected(rt) === true && (await jobsEnabled(rt))) {
        // Honest empty state: surface any job that failed or has gone overdue,
        // so "nothing here" is never confused with "the scan never looked".
        const enabled = (await rt.store.jobs.list()).filter((w) => w.enabled)
        const overdue = await overdueJobs(rt, enabled, now)
        for (const w of enabled) {
          if (w.lastRunStatus === 'failed') {
            notices.push(`job “${w.title}” last run failed${w.lastRunError ? `: ${w.lastRunError}` : ''}`)
          } else if (overdue.has(w.id)) {
            notices.push(`job “${w.title}” hasn’t completed a run recently — items from it may be missing`)
          }
        }
      }
      const { items: ranked } = buildInbox({ items, notices, now, weights: await readScoreWeights(rt) })
      await withFlows(rt, ranked, true)
      const tasks = await rt.store.tasks.forItems(ranked.map((i) => i.id))
      for (const i of ranked) {
        const sum = taskSummary(tasks.get(i.id) ?? [])
        if (sum) i.tasks = sum
      }
      await withJunior(rt, ranked, tasks)
      // what Junior did on them that you haven't looked at (core/work/supervision.ts); never fails the sync
      await withSupervision(rt, ranked, tasks)
      // the attention split's record of what reached you (core/junior/attention.ts); never fails the sync
      await recordSurfaced(rt.store.items, ranked, now).then(
        (ids) => ids.length && log('info', 'inbox', `${ids.length} item(s) reached Needs you`, { ids, workspace: rt.meta.id }),
        (err) => log('warn', 'inbox', `could not record what reached Needs you: ${errText(err)}`, { workspace: rt.meta.id }),
      )
      const [landedToday, alerts, counts] = await Promise.all([
        rt.store.items.countDoneSince(startOfDay(now)),
        inboxAlerts(rt),
        statusCounts(rt, now),
      ])
      rt.inboxCache = { syncedAt: now, items: ranked, notices, landedToday, alerts, counts }
      void rt.store.inbox.save(rt.inboxCache)
      return rt.inboxCache
    } finally {
      rt.inboxInFlight = null
    }
  })()
  return rt.inboxInFlight
}

/**
 * Archive old FYI nobody touched (core/work/fade.ts). A recorded system
 * transition, so it shows in the item's history and can be reopened.
 */
async function fadeOldFyi(rt: WorkspaceRuntime, now: number): Promise<void> {
  const links = await rt.store.links.list()
  const touched = new Set(links.flatMap((l) => [l.fromKind === 'item' ? l.fromId : '', l.toKind === 'item' ? l.toId : '']))
  const faded = (await rt.store.items.list('open')).filter((i) => shouldArchive(i, now, touched))
  for (const i of faded) {
    await rt.store.items.transition(i.id, {
      status: 'archived',
      actor: 'system',
      detail: { reason: `FYI untouched for ${ARCHIVE_AFTER_DAYS} days` },
    })
  }
  if (faded.length) log('info', 'inbox', `archived ${faded.length} old FYI item(s)`, { ids: faded.map((i) => i.id), workspace: rt.meta.id })
}

/**
 * Drop GitHub items outside this workspace's repo scope (.docs/workspaces.md).
 * Repo scope is per-workspace and empty = none, so a workspace only ever shows
 * PRs/issues from the repos it opted into, even for rows ingested earlier under
 * a wider (or account-wide) scope. Non-destructive: nothing is mutated, so
 * re-scoping a repo makes its items reappear at once. Other sources pass through.
 */
function scopeGitHub<T extends { source: string; repo: string }>(items: T[], scoped: Set<string>): T[] {
  return items.filter((i) => i.source !== 'github' || scoped.has(i.repo))
}

/** Ranked items for a status tab other than the open inbox (read-only, no scan). */
export async function listItemsByStatus(rt: WorkspaceRuntime, status: ItemStatus, now = Date.now()): Promise<InboxSnapshot['items']> {
  const scoped = new Set(await connectedRepos(rt))
  const items = scopeGitHub(await rt.store.items.list(status), scoped)
  if (status === 'archived') {
    const deleted = await rt.store.items.deletedIds()
    for (const i of items) if (deleted.has(i.id)) i.deleted = true
  }
  return withFlows(rt, linkByRefs(rank(items, now, await readScoreWeights(rt))), false)
}

/** How many rows each status tab holds. The same scoping and folding its list gets. */
async function statusCounts(rt: WorkspaceRuntime, now: number): Promise<NonNullable<InboxSnapshot['counts']>> {
  const scoped = new Set(await connectedRepos(rt))
  const rows = async (s: ItemStatus) => linkByRefs(rank(scopeGitHub(await rt.store.items.list(s), scoped), now)).length
  const [snoozed, archived] = await Promise.all([rows('snoozed'), rows('archived')])
  return { snoozed, archived }
}

// The repo picker's "available" list; slow-ish (paginated), so cached.
export async function affiliatedRepos(rt: WorkspaceRuntime): Promise<string[]> {
  if (rt.affiliatedCache && Date.now() - rt.affiliatedCache.at < 10 * 60_000) return rt.affiliatedCache.repos
  const repos = await listAffiliatedRepos()
  rt.affiliatedCache = { at: Date.now(), repos }
  return repos
}

export async function getInbox(rt: WorkspaceRuntime, force: boolean): Promise<InboxSnapshot> {
  if (!force && rt.inboxCache && Date.now() - rt.inboxCache.syncedAt < INBOX_TTL_MS) return rt.inboxCache
  return syncInbox(rt)
}
