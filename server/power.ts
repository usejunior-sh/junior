/**
 * Power (goals-mapping.md, M0 findings and decision 10): a job run that
 * starts on a macOS DarkWake froze when the Mac went back to sleep seconds
 * later, and ended only at a later wake. Two answers, both daemon-wide:
 *
 * - a power assertion, held while any job run (or, later, goal) is active:
 *   `caffeinate -i -s -w <daemon pid>` — no idle sleep, no system sleep on
 *   AC — killed when the last holder lets go, and gone with the daemon.
 *   A no-op off macOS.
 * - a sleep watch, ticked every few seconds: a long silence between ticks
 *   was sleep, so a run can be recorded `slept` (core/goals/run-guard.ts).
 */
import { spawn } from 'node:child_process'
import { SLEEP_TICK_MS, SleepWatch } from '../core/goals/run-guard.js'

/** What the assertion needs of a child process — `ChildProcess` fits; tests pass a fake. */
export type Assertion = { kill(): void; once(event: 'exit', cb: () => void): void }
export type SpawnAssertion = () => Assertion | null

const caffeinate: SpawnAssertion = () => {
  if (process.platform !== 'darwin') return null
  const child = spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(process.pid)], { stdio: 'ignore' })
  // A missing binary is an 'error', not a throw: no assertion, nothing breaks.
  child.on('error', () => {})
  child.unref()
  return child
}

/**
 * One assertion for the whole daemon, held while anyone holds it. `hold`
 * returns its release; releasing twice is a no-op, so a slot freed both by
 * its run and by the watchdog lets go once.
 */
export class PowerAssertion {
  private readonly holders = new Map<number, string>()
  private next = 0
  private child: Assertion | null = null

  constructor(private readonly spawnOne: SpawnAssertion = caffeinate) {}

  /** Who is keeping the Mac awake now — for status and logs. */
  get reasons(): string[] {
    return [...this.holders.values()]
  }

  get held(): boolean {
    return this.child !== null
  }

  hold(reason: string): () => void {
    const id = this.next++
    this.holders.set(id, reason)
    if (!this.child) this.start()
    return () => {
      if (!this.holders.delete(id)) return
      if (this.holders.size === 0) this.stop()
    }
  }

  private start(): void {
    let child: Assertion | null = null
    try {
      child = this.spawnOne()
    } catch {
      child = null
    }
    if (!child) return
    this.child = child
    // Died on its own (killed from outside): the next hold starts another.
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
  }

  private stop(): void {
    const child = this.child
    this.child = null
    try {
      child?.kill()
    } catch {
      // already gone
    }
  }
}

export const power = new PowerAssertion()
export const sleepWatch = new SleepWatch()

let ticking: NodeJS.Timeout | null = null

/** Start the sleep watch's heartbeat (once per daemon). */
export function startSleepWatch(): void {
  if (ticking) return
  sleepWatch.tick(Date.now())
  ticking = setInterval(() => sleepWatch.tick(Date.now()), SLEEP_TICK_MS)
  ticking.unref()
}
