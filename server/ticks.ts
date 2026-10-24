import { startSleepWatch } from './power.js'
import { log } from './log.js'
import { runtimes } from './workspace/runtime.js'
import { runDueJobs } from './jobs/queue.js'
import { tickActions } from './session/actions-send.js'
import { errText } from './errors.js'
import { wakeTeamGoals } from './team-run/mcp.js'
import { invalidateInbox } from './ws/send.js'
import { SCHEDULER_TICK_MS } from './jobs/scheduler.js'
import { INBOX_KEEP_WARM_MS, syncInbox } from './inbox/sync.js'
import { babysitTick } from './babysit/glue.js'
import { reviewTick } from './review/glue.js'
import { sweepLearningsTick } from './learnings-ops.js'
// the runner registers its hooks on the babysit tick when loaded
import './tasks/runner.js'
import { BABYSIT_FAST_MS } from '../core/babysit/watch.js'

/** when the scheduler last ticked: daemon-wide, surfaced in the System status. */
export let lastSchedulerTickAt: number | null = null

export function startTicks() {
  // The sleep watch's heartbeat: a long silence between beats was sleep, so a
  // run the Mac slept through is recorded `slept` (server/power.ts).
  startSleepWatch()

  // The minute tick (.docs/jobs.md): due jobs run, elapsed snoozes wake, in
  // every workspace. No cron: the server is the long-running process; missed
  // runs are simply due on the first tick after wake.
  setInterval(() => {
    lastSchedulerTickAt = Date.now()
    for (const rt of runtimes.values()) {
      runDueJobs(rt).catch((err) => log('error', 'scheduler', `tick failed: ${err}`, { workspace: rt.meta.id }))
      // Queued actions: expire the stale, send what a lost timer left due.
      tickActions(rt).catch((err) => log('error', 'actions', `tick failed: ${errText(err)}`, { workspace: rt.meta.id }))
      // Goals asleep on the world: time's up, Junior looks again.
      wakeTeamGoals(rt).catch((err) => log('error', 'teams', `goal wake failed: ${errText(err)}`, { workspace: rt.meta.id }))
      // Learnings unused for 28 days go (at most every 6 hours; never throws).
      void sweepLearningsTick(rt)
      rt.store.items
        .wakeSnoozed(Date.now())
        .then((woken) => {
          if (woken.length > 0) {
            invalidateInbox(rt)
            log('info', 'scheduler', `woke ${woken.length} snoozed item(s)`, { ids: woken, workspace: rt.meta.id })
          }
        })
        .catch((err) => log('error', 'scheduler', `snooze wake failed: ${err}`, { workspace: rt.meta.id }))
    }
  }, SCHEDULER_TICK_MS).unref()

  // Babysitting your PRs: a cheap tick; the search runs every minute while
  // something moves, every 5 otherwise (core/babysit/watch.ts).
  setInterval(() => {
    for (const rt of runtimes.values()) babysitTick(rt).catch((err) => log('error', 'babysit', `tick failed: ${errText(err)}`, { workspace: rt.meta.id }))
  }, BABYSIT_FAST_MS).unref()

  // First-pass reviews of PRs that ask for yours: the search runs every 2
  // minutes while they're on (core/review/watch.ts).
  setInterval(() => {
    for (const rt of runtimes.values()) reviewTick(rt).catch((err) => log('error', 'review', `tick failed: ${errText(err)}`, { workspace: rt.meta.id }))
  }, BABYSIT_FAST_MS).unref()

  // Keep the caches warm while the server runs, so page loads are instant. A
  // failed background sync keeps the previous snapshot; the next view retries.
  setInterval(() => {
    for (const rt of runtimes.values()) {
      syncInbox(rt).catch((err) => log('error', 'inbox', `background sync failed: ${err}`, { workspace: rt.meta.id }))
    }
  }, INBOX_KEEP_WARM_MS).unref()
}
