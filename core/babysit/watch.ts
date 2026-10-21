/**
 * The babysit playbook's watch: what's new on one of your PRs, and the task
 * it becomes (plan artifact f39a3a5e, "Babysit playbook").
 *
 *   CI red             → "Fix lint" (Junior); a check that looks flaky is rerun once first
 *   bot thread         → "Fix Bugbot comment on api.ts" (Junior: fix, push, reply, resolve)
 *   person's thread    → "Answer Anirudha" (you)
 *   conflict / behind  → "Rebase on main" (Junior)
 *   green, no reviewer → "Request Anirudha" (you: the request is held for your OK)
 *
 * Caps: a check fixed MAX_FIX_ATTEMPTS times, or a bot comment that comes
 * back after a fix, becomes a task on you, and Junior is stuck on that PR
 * until you answer. Tasks dedupe on their key in the store, so an event read
 * twice adds one task; the watch keeps only what keys can't (counts, reruns).
 *
 * Pure: no I/O, no clock. Reuses the shepherd's flake test and fingerprints.
 */
import { MAX_FIX_ATTEMPTS } from '../goals/types.js'
import { fingerprint, looksFlaky, type PrCheck, type PrThread } from '../goals/shepherd.js'
import type { NewTask } from '../work/tasks.js'
import type { BabysitPr } from './pr.js'

export { MAX_FIX_ATTEMPTS }

/** What the watch remembers about one PR between polls. */
export type BabysitWatch = {
  headSha: string | null
  /** fix tasks added per check name */
  fixes: Record<string, number>
  /** `check@sha` reruns spent: one each */
  reruns: string[]
  /** fingerprints of bot comments Junior already took on */
  botPrints: string[]
}

export const newBabysitWatch = (): BabysitWatch => ({ headSha: null, fixes: {}, reruns: [], botPrints: [] })

const MAX_KEPT = 200

export type BabysitEvent =
  | { kind: 'checks_failed'; sha: string; check: PrCheck }
  | { kind: 'bot_thread'; thread: PrThread }
  | { kind: 'human_thread'; thread: PrThread }
  | { kind: 'rebase'; sha: string; why: 'conflict' | 'behind' }
  | { kind: 'green'; sha: string }

const settled = (c: PrCheck) => c.status === 'success' || c.status === 'neutral'

/** Ready for a reviewer: every check green, nothing open from a bot, no conflict, and nobody asked yet. */
export function readyForReview(pr: BabysitPr): boolean {
  return (
    pr.state === 'OPEN' &&
    pr.checks.every(settled) &&
    !pr.threads.some((t) => t.isBot && !t.resolved) &&
    pr.mergeable === 'MERGEABLE' &&
    !pr.behind &&
    pr.reviewers.length === 0 &&
    !pr.reviewed &&
    pr.reviewDecision !== 'APPROVED'
  )
}

/** Everything the PR shows right now that could need a task, in the order to act on it. */
export function babysitEvents(pr: BabysitPr): BabysitEvent[] {
  if (pr.state !== 'OPEN') return []
  const out: BabysitEvent[] = []
  const sha = pr.headSha
  for (const check of pr.checks) if (check.status === 'failure') out.push({ kind: 'checks_failed', sha, check })
  for (const thread of pr.threads) if (!thread.resolved) out.push({ kind: thread.isBot ? 'bot_thread' : 'human_thread', thread })
  if (pr.mergeable === 'CONFLICTING') out.push({ kind: 'rebase', sha, why: 'conflict' })
  else if (pr.behind) out.push({ kind: 'rebase', sha, why: 'behind' })
  if (readyForReview(pr)) out.push({ kind: 'green', sha })
  return out
}

/** "cursor[bot]" → "Bugbot", "coderabbitai[bot]" → "coderabbitai". */
export function botName(login: string): string {
  const base = login.replace(/\[bot\]$/, '')
  return base === 'cursor' ? 'Bugbot' : base
}

const fileOf = (path: string | null) => (path ? path.split('/').pop()! : null)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export type TaskSpec = Omit<NewTask, 'itemId'> & { key: string; step: string }

export type BabysitDecision =
  | { do: 'task'; task: TaskSpec; stuck?: true }
  | { do: 'rerun'; check: PrCheck }
  | { do: 'none' }

export type DecideContext = {
  base: string
  isDraft: boolean
  /** the reviewer Junior suggests; null when it hasn't learned one */
  reviewer: string | null
  /** the failing check's log, for the flake test */
  log?: string
}

/** What one event becomes, with the caps applied. */
export function decide(ev: BabysitEvent, w: BabysitWatch, ctx: DecideContext): BabysitDecision {
  switch (ev.kind) {
    case 'checks_failed': {
      const name = ev.check.name
      const flaky = looksFlaky(ctx.log ?? '') || /^(TIMED_OUT|CANCELLED|STARTUP_FAILURE)$/.test(ev.check.conclusion ?? '')
      if (ev.check.runId !== null && flaky && !w.reruns.includes(`${name}@${ev.sha}`)) return { do: 'rerun', check: ev.check }
      const tries = w.fixes[name] ?? 0
      if (tries >= MAX_FIX_ATTEMPTS)
        return {
          do: 'task',
          stuck: true,
          task: {
            title: `${clip(name, 60)} still fails after ${tries} fixes`,
            owner: 'you',
            state: 'waiting',
            why: 'event',
            whyDetail: `CI red: ${name}`,
            step: 'stuck',
            key: `stuck:ci:${name}`,
            input: { sha: ev.sha, check: name, url: ev.check.url },
          },
        }
      return {
        do: 'task',
        task: {
          title: `Fix ${clip(name, 60)}`,
          owner: 'junior',
          why: 'event',
          whyDetail: `CI red: ${name}`,
          step: 'fix-ci',
          key: `ci:${ev.sha}:${name}`,
          input: { sha: ev.sha, check: name, runId: ev.check.runId, url: ev.check.url, attempt: tries + 1 },
        },
      }
    }
    case 'bot_thread': {
      const t = ev.thread
      const who = botName(t.author)
      const file = fileOf(t.path)
      const input = { threadId: t.id, author: t.author, path: t.path, body: clip(t.body, 4_000), url: t.url }
      if (w.botPrints.includes(fingerprint(t)))
        return {
          do: 'task',
          stuck: true,
          task: { title: `${who} raised the same comment again${file ? ` on ${file}` : ''}`, owner: 'you', state: 'waiting', why: 'event', whyDetail: `${who} comment came back`, step: 'stuck', key: `stuck:thread:${t.id}`, input },
        }
      return {
        do: 'task',
        task: { title: `Fix ${who} comment${file ? ` on ${file}` : ''}`, owner: 'junior', why: 'event', whyDetail: `${who} comment`, step: 'fix-thread', key: `thread:${t.id}`, input },
      }
    }
    case 'human_thread': {
      const t = ev.thread
      const file = fileOf(t.path)
      return {
        do: 'task',
        task: {
          title: `Answer ${t.author}${file ? ` on ${file}` : ''}`,
          owner: 'you',
          state: 'waiting',
          why: 'event',
          whyDetail: `${t.author} commented`,
          step: 'reply-thread',
          key: `thread:${t.id}`,
          input: { threadId: t.id, author: t.author, path: t.path, body: clip(t.body, 4_000), url: t.url },
        },
      }
    }
    case 'rebase':
      return {
        do: 'task',
        task: {
          title: `Rebase on ${ctx.base}`,
          owner: 'junior',
          why: 'event',
          whyDetail: ev.why === 'conflict' ? `conflicts with ${ctx.base}` : `behind ${ctx.base}`,
          step: 'rebase',
          key: `rebase:${ev.sha}`,
          input: { sha: ev.sha, base: ctx.base, why: ev.why },
        },
      }
    case 'green': {
      const who = ctx.reviewer ?? 'a reviewer'
      return {
        do: 'task',
        task: {
          title: ctx.isDraft ? `Mark ready + request ${who}` : `Request ${who}`,
          owner: 'you',
          state: 'waiting',
          why: 'playbook',
          whyDetail: 'green',
          step: 'request-review',
          // once per PR: a request you skipped isn't asked again on every push
          key: 'request-review',
          input: { sha: ev.sha, reviewer: ctx.reviewer, draft: ctx.isDraft },
        },
      }
    }
  }
}

/** The watch once a decision was carried out: the caps count it. Call only when the task was added. */
export function afterDecision(w: BabysitWatch, ev: BabysitEvent, d: BabysitDecision): BabysitWatch {
  if (d.do === 'rerun' && ev.kind === 'checks_failed') return { ...w, reruns: [...w.reruns, `${ev.check.name}@${ev.sha}`].slice(-MAX_KEPT) }
  if (d.do !== 'task' || d.stuck) return w
  if (ev.kind === 'checks_failed') return { ...w, fixes: { ...w.fixes, [ev.check.name]: (w.fixes[ev.check.name] ?? 0) + 1 } }
  if (ev.kind === 'bot_thread') return { ...w, botPrints: [...w.botPrints, fingerprint(ev.thread)].slice(-MAX_KEPT) }
  return w
}

/**
 * A queued task whose PR has moved on: a fix or rebase written for an older
 * head would fight the new one. The runner skips it; the next poll adds a
 * fresh task if the problem is still there.
 */
export function isStale(task: { step?: string; input?: Record<string, unknown> }, headSha: string | null): boolean {
  if (!headSha || (task.step !== 'fix-ci' && task.step !== 'rebase')) return false
  return typeof task.input?.sha === 'string' && task.input.sha !== headSha
}

/** Minutes between polls: every minute while something is moving, else every 5. */
export const BABYSIT_FAST_MS = 60_000
export const BABYSIT_SLOW_MS = 5 * 60_000

/** Something is moving: a check is still running, or Junior has work queued or running. */
export function pollSoon(prs: readonly BabysitPr[], busy: boolean): boolean {
  return busy || prs.some((p) => p.checks.some((c) => c.status === 'pending'))
}
