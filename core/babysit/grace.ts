/**
 * The grace period before the first fix (.docs/overnight-2026-10-24/designs/fix-grace-period.md).
 * You push, CI goes red, and Junior used to add "Fix lint" on the next poll,
 * so you both fixed the same check. Now a head you pushed gets `graceMinutes`
 * (default 10) before Junior's fix: green by then, nothing is added; still
 * red, the next poll adds it; push again, a new head starts a new window.
 *
 * A head is Junior's own push when a task on the item reported that commit
 * (`output.sha`), a Junior task on the item is still running (it may have
 * pushed and not reported yet), or the action log holds a push on the item
 * since the head was first seen, less a little slack. Junior's own push
 * starts no window. The first poll of a PR gets no window: there is no
 * earlier head to say a push happened.
 *
 * The row reads the result on the PR's `seen` (core/work/handoff.ts):
 * `graceUntil` while a fix is held, else `fixes` once Junior has tried.
 * Grace and the fraction never show together.
 *
 * Pure: no I/O, time is an argument. Browser-safe.
 */
import { MAX_FIX_ATTEMPTS } from './ci.js'

export const DEFAULT_GRACE_MINUTES = 10
export const MAX_GRACE_MINUTES = 60

/** A push recorded this long before the head was first seen still counts as the one that made it. */
export const PUSH_SLACK_MS = 15 * 60_000

/** What the watch keeps per head for the window. */
export type HeadGrace = {
  /** when this poll's head was first seen: stands in for the push time */
  headSeenAt?: number
  /** a fix waits until then; null = no window on this head */
  graceUntil?: number | null
}

/**
 * The window for the head this poll reads. Same head: the window kept, unless
 * the push has since turned out to be Junior's. New head after an earlier one:
 * a window, unless Junior pushed it or grace is off (0 minutes).
 */
export function graceFor(prev: { headSha: string | null } & HeadGrace | undefined, headSha: string, now: number, graceMinutes: number, juniorPushed: boolean): Required<HeadGrace> {
  if (prev && prev.headSha === headSha) {
    const seenAt = prev.headSeenAt ?? now
    return { headSeenAt: seenAt, graceUntil: juniorPushed ? null : (prev.graceUntil ?? null) }
  }
  const pushed = !!prev?.headSha
  const minutes = Math.max(0, Math.min(MAX_GRACE_MINUTES, graceMinutes))
  return { headSeenAt: now, graceUntil: pushed && !juniorPushed && minutes > 0 ? now + minutes * 60_000 : null }
}

/** The window is open: a fix for this head waits. */
export const inGrace = (g: Pick<HeadGrace, 'graceUntil'> | undefined, now: number): boolean => typeof g?.graceUntil === 'number' && now < g.graceUntil

/** What the item's tasks and the action log say about who pushed `headSha`. */
export type PushFacts = {
  tasks: readonly { owner: string; state: string; output?: { sha?: string } }[]
  /** push records filed against the item, when they were attempted */
  pushes: readonly { attemptedAt: number }[]
  /** when the head was first seen (graceFor's headSeenAt; now on a new head) */
  headSeenAt: number
}

/** Short and long shas name the same commit when one starts with the other. */
const sameSha = (a: string, b: string) => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

/** Junior made this head: a task reported it, a task of Junior's is mid-run, or a push on the item came just before it. */
export function juniorPushed(headSha: string, f: PushFacts): boolean {
  if (f.tasks.some((t) => typeof t.output?.sha === 'string' && sameSha(t.output.sha, headSha))) return true
  if (f.tasks.some((t) => t.owner === 'junior' && t.state === 'running')) return true
  return f.pushes.some((p) => p.attemptedAt >= f.headSeenAt - PUSH_SLACK_MS)
}

/**
 * The count a row shows: the most fixes spent on any check red now, minus the
 * ones already stuck (their task on you says it). Null = nothing to show.
 */
export function fixesShown(fixes: Readonly<Record<string, number>>, red: readonly string[], stuck: readonly string[] = []): number | null {
  let n = 0
  for (const c of red) if (!stuck.includes(c)) n = Math.max(n, Math.min(MAX_FIX_ATTEMPTS, fixes[c] ?? 0))
  return n > 0 ? n : null
}

/** "fix 2 of 3": the cap is MAX_FIX_ATTEMPTS, never a literal. */
export const fixFraction = (n: number): string => `fix ${n} of ${MAX_FIX_ATTEMPTS}`

/** "3:42 PM", in the viewer's locale. */
export const clockTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** The two reasons a row shows while a fix waits. */
export const graceReasons = (until: number): string[] => ['you just pushed', `fix after ${clockTime(until)}`]

/** What a PR's `seen` says to show now: the window while it's open, else the fraction. */
export function graceShown(seen: { graceUntil?: number; fixes?: number } | undefined, now: number): { graceUntil: number } | { fixes: number } | null {
  if (typeof seen?.graceUntil === 'number' && now < seen.graceUntil) return { graceUntil: seen.graceUntil }
  if (typeof seen?.fixes === 'number' && seen.fixes > 0) return { fixes: seen.fixes }
  return null
}
