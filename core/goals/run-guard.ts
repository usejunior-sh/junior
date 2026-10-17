/**
 * What keeps a headless run honest about time (.docs/goals/goals-mapping.md):
 * a sleep watch, so a run the Mac slept through is recorded `slept` rather
 * than failed or interrupted, and a hard stop, so a run past its timeout ends
 * and is recorded even when its stream never closes.
 *
 * Pure: no timers and no clock of its own. The caller ticks the watch and
 * passes `now`. Node's monotonic clock counts sleep on macOS, so it can't
 * tell a slept span from a slow one; a gap between heartbeats can, because
 * timers don't fire while the machine sleeps.
 */
import type { JobRunStatus } from '../job/types.js'

/** How often the daemon ticks the watch. */
export const SLEEP_TICK_MS = 5_000
/** A gap between ticks longer than this was sleep (a busy event loop never stalls this long). */
export const SLEEP_GAP_MS = 30_000
/** A run that lost at least this much to sleep, and didn't finish, is recorded `slept`. */
export const SLEPT_MIN_MS = 60_000
/** Gaps kept: about a day at one sleep every ten minutes. */
const MAX_GAPS = 200

export type Gap = { from: number; to: number }

export class SleepWatch {
  private last: number | null = null
  private readonly gaps: Gap[] = []

  /** One heartbeat. A long silence since the last one is recorded as a gap. */
  tick(now: number): void {
    if (this.last !== null && now - this.last > SLEEP_GAP_MS) {
      this.gaps.push({ from: this.last, to: now })
      if (this.gaps.length > MAX_GAPS) this.gaps.splice(0, this.gaps.length - MAX_GAPS)
    }
    this.last = now
  }

  /**
   * How long the machine slept between `from` and `now`. Counts the silence
   * still open since the last tick, so a run ending right at wake, before
   * the first heartbeat after it, still sees the sleep it ended in.
   */
  sleptBetween(from: number, now: number): number {
    const spans = [...this.gaps]
    if (this.last !== null && now - this.last > SLEEP_GAP_MS) spans.push({ from: this.last, to: now })
    let ms = 0
    for (const g of spans) {
      const a = Math.max(g.from, from)
      const b = Math.min(g.to, now)
      if (b > a) ms += b - a
    }
    return ms
  }
}

/**
 * A run's status once sleep is accounted for. A run that finished `ok` keeps
 * it, however long it slept; one that failed, timed out or was interrupted
 * while losing `SLEPT_MIN_MS` or more to sleep is `slept`, with why.
 */
export function settleRunStatus(status: JobRunStatus, sleptMs: number, error?: string): { status: JobRunStatus; error?: string } {
  if (status === 'ok' || status === 'skipped' || sleptMs < SLEPT_MIN_MS) return { status, ...(error ? { error } : {}) }
  const why = `the Mac slept ${Math.round(sleptMs / 60_000)} min during the run`
  return { status: 'slept', error: error ? `${why} — ${error}` : why }
}

const STOPPED: unique symbol = Symbol('stopped')

/** What a hard-stopped iteration throws. */
export class HardStop extends Error {
  constructor(message = 'stopped: the run did not end after it was aborted') {
    super(message)
    this.name = 'HardStop'
  }
}

/**
 * Iterate `src` until it ends or `stop` settles, whichever is first. On stop
 * the source is told to return (not awaited: a hung one never answers) and
 * the loop throws `HardStop`, so the caller's catch and finally always run.
 */
export async function* untilStopped<T>(src: AsyncIterable<T>, stop: Promise<unknown>): AsyncGenerator<T> {
  const it = src[Symbol.asyncIterator]()
  const stopped: Promise<typeof STOPPED> = stop.then(
    () => STOPPED,
    () => STOPPED,
  )
  try {
    for (;;) {
      const r = await Promise.race([it.next(), stopped])
      if (r === STOPPED) throw new HardStop()
      if (r.done) return
      yield r.value
    }
  } finally {
    // Stopped, or an early exit by the caller: close the source as for-await would.
    void Promise.resolve(it.return?.()).catch(() => {})
  }
}
