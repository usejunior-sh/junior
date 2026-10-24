/**
 * The babysit playbook's watch: what's new on one of your PRs, and the task
 * it becomes (plan artifact f39a3a5e, "Babysit playbook").
 *
 *   CI red             → "Fix lint" (Junior); a check that looks flaky is rerun once first,
 *                        one red on main too adds nothing (ci-sort.ts: "not yours"), and
 *                        right after your push the fix waits out a grace window (grace.ts)
 *   bot threads        → "Triage 3 bot comments" (Junior: a verdict per thread, sends
 *                        nothing); its fix verdicts become "Fix Bugbot comment on api.ts"
 *                        (Junior: fix, push, reply, resolve). New threads from the five
 *                        review bots (bot-triage.ts) are grouped into one triage task per
 *                        poll; any other bot's thread is a fix task straight away
 *   person's thread    → "Answer Anirudha" (you)
 *   conflict / behind  → "Rebase on main" (Junior)
 *   green, no reviewer → "Request Anirudha" (you: the request is held for your OK)
 *
 * Caps: a check fixed MAX_FIX_ATTEMPTS times, or a bot comment that comes
 * back after a fix, becomes a task on you, and Junior is stuck on that PR
 * until you answer. Tasks dedupe on their key in the store, so an event read
 * twice adds one task; the watch keeps only what keys can't (counts, reruns).
 *
 * Pure: no I/O, no clock. The flake test and fingerprints are ci.ts's.
 */
import { fingerprint, looksFlaky, MAX_FIX_ATTEMPTS, type PrCheck, type PrThread } from './ci.js'
import type { NewTask } from '../work/tasks.js'
import type { PrSeen } from '../work/handoff.js'
import type { BabysitPr } from './pr.js'
import type { CiSort } from './ci-sort.js'
import { readiness, readyLine, type Readiness } from './ready.js'
import { findingOf, verdictsFor, type Bot, type Verdict } from './bot-triage.js'

export { MAX_FIX_ATTEMPTS }

/** What the watch remembers about one PR between polls. */
export type BabysitWatch = {
  headSha: string | null
  /** the PR's branches, as of the last poll: the runner checks out and pushes these */
  headRef?: string
  baseRef?: string
  /** fix tasks added per check name */
  fixes: Record<string, number>
  /** `check@sha` reruns spent: one each */
  reruns: string[]
  /** fingerprints of bot comments Junior already took on */
  botPrints: string[]
  /** the threads those came from: one still open is the same comment, not one that came back */
  botThreads?: string[]
  /** what the last poll saw, for a PR's suggestion; kept whether or not you handed it off */
  seen?: PrSeen
  /** when `headSha` was first seen: stands in for the push time (grace.ts) */
  headSeenAt?: number
  /** you pushed `headSha`: Junior's first fix on it waits until then; null = no window */
  graceUntil?: number | null
  /** `check@sha` logs read during a window, for the flake test: once each */
  graceLogs?: string[]
}

export function seenOf(pr: BabysitPr): PrSeen {
  const open = pr.threads.filter((t) => !t.resolved)
  return {
    red: pr.checks.filter((c) => c.status === 'failure').map((c) => c.name),
    bots: open.filter((t) => t.isBot).length,
    people: open.filter((t) => !t.isBot).length,
    rebase: pr.mergeable === 'CONFLICTING' ? 'conflict' : pr.behind ? 'behind' : null,
    draft: pr.isDraft,
    ready: readiness(pr),
  }
}

export const newBabysitWatch = (): BabysitWatch => ({ headSha: null, fixes: {}, reruns: [], botPrints: [] })

const MAX_KEPT = 200

export type BabysitEvent =
  | { kind: 'checks_failed'; sha: string; check: PrCheck }
  | { kind: 'bot_thread'; thread: PrThread }
  /** new threads from the five review bots, grouped by batchBotThreads: one triage task */
  | { kind: 'bot_triage'; threads: PrThread[] }
  | { kind: 'human_thread'; thread: PrThread }
  | { kind: 'rebase'; sha: string; why: 'conflict' | 'behind' }
  /** `ready`: the gate it passed (ready.ts), for the hand-back's line */
  | { kind: 'green'; sha: string; ready?: Readiness }

/**
 * Ready for a reviewer: the hand-back gate passes (ready.ts: every check
 * green, no thread open from a bot or a person, no conflict, not behind) and
 * nobody was asked yet. At least one check must have reported: a PR whose CI
 * hasn't started yet isn't green. (A repo with no CI at all is never offered
 * the request; ask in chat.)
 */
export function readyForReview(pr: BabysitPr, ready: Readiness = readiness(pr)): boolean {
  return pr.state === 'OPEN' && ready.ready && pr.reviewers.length === 0 && !pr.reviewed && pr.reviewDecision !== 'APPROVED'
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
  const ready = readiness(pr)
  if (readyForReview(pr, ready)) out.push({ kind: 'green', sha, ready })
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
  /** you just pushed: the fix waits until `until` (grace.ts) */
  | { do: 'wait'; until: number }
  | { do: 'none' }

export type DecideContext = {
  base: string
  isDraft: boolean
  /** the reviewer Junior suggests; null when it hasn't learned one */
  reviewer: string | null
  /** the failing check's log, for the flake test */
  log?: string
  /**
   * The failing check, sorted (ci-sort.ts): main-red adds nothing, flaky is
   * rerun once, fix is fixed. Absent = not sorted, and the log's flake test decides.
   */
  sort?: CiSort
  /** you pushed this head: a fix waits until then (grace.ts); needs `now` */
  graceUntil?: number | null
  now?: number
}

/** What one event becomes, with the caps applied. */
export function decide(ev: BabysitEvent, w: BabysitWatch, ctx: DecideContext): BabysitDecision {
  switch (ev.kind) {
    case 'checks_failed': {
      const name = ev.check.name
      // red on main too: not this PR's, so no fix, no rerun, nothing counted
      if (ctx.sort?.verdict === 'main-red') return { do: 'none' }
      const flaky = ctx.sort ? ctx.sort.verdict === 'flaky' : looksFlaky(ctx.log ?? '') || /^(TIMED_OUT|CANCELLED|STARTUP_FAILURE)$/.test(ev.check.conclusion ?? '')
      if (ev.check.runId !== null && flaky && !w.reruns.includes(`${name}@${ev.sha}`)) return { do: 'rerun', check: ev.check }
      const tries = w.fixes[name] ?? 0
      // you just pushed: give your fix a chance before Junior starts one (a rerun above still runs)
      if (typeof ctx.graceUntil === 'number' && ctx.now !== undefined && ctx.now < ctx.graceUntil) return { do: 'wait', until: ctx.graceUntil }
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
      const input = threadInput(t)
      // Still open while Junior works on it, or after it handed in blocked: its task already says so.
      if (w.botThreads?.includes(t.id)) return { do: 'none' }
      if (w.botPrints.includes(fingerprint(t)))
        return {
          do: 'task',
          stuck: true,
          task: { title: `${who} raised the same comment again${file ? ` on ${file}` : ''}`, owner: 'you', state: 'waiting', why: 'event', whyDetail: `${who} comment came back`, step: 'stuck', key: `stuck:thread:${t.id}`, input },
        }
      return { do: 'task', task: fixThreadTask(t) }
    }
    case 'bot_triage': {
      const threads = ev.threads.filter((t) => !w.botThreads?.includes(t.id))
      if (!threads.length) return { do: 'none' }
      return { do: 'task', task: triageTask(threads) }
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
          // the hand-back's line: what was checked, so you don't open the PR to check
          whyDetail: ev.ready ? readyLine(ev.ready) : 'green',
          step: 'request-review',
          // once per PR: a request you skipped isn't asked again on every push
          key: 'request-review',
          input: { sha: ev.sha, reviewer: ctx.reviewer, draft: ctx.isDraft, ...(ev.ready ? { ready: ev.ready.checks } : {}) },
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
  if (ev.kind === 'bot_thread' || ev.kind === 'bot_triage') {
    const threads = ev.kind === 'bot_thread' ? [ev.thread] : ev.threads
    return {
      ...w,
      botPrints: [...w.botPrints, ...threads.map(fingerprint)].slice(-MAX_KEPT),
      botThreads: [...(w.botThreads ?? []), ...threads.map((t) => t.id)].slice(-MAX_KEPT),
    }
  }
  return w
}

// ---------------------------------------------------------------------------
// Bot triage (plan item bot-triage-task): new bot threads → one triage task →
// a verdict per thread (bot-triage.ts) → fix tasks for the fixes, the rest
// kept on the task for the replies the user sends (bot-triage-send).

/** The step of the task that sorts a PR's new bot threads. It reads; it never sends. */
export const TRIAGE_BOT_STEP = 'triage-bot'

/** Threads one triage task takes; the rest wait for the next poll. */
export const MAX_TRIAGE_THREADS = 20

/** One bot thread as a task carries it. */
function threadInput(t: PrThread): Record<string, unknown> {
  return { threadId: t.id, author: t.author, path: t.path, ...(typeof t.line === 'number' ? { line: t.line } : {}), body: clip(t.body, 4_000), url: t.url }
}

/** "Fix Bugbot comment on api.ts": Junior fixes, pushes, replies and resolves. `why` = triage's reason, when it ran. */
export function fixThreadTask(t: PrThread, why?: string): TaskSpec {
  const who = botName(t.author)
  const file = fileOf(t.path)
  return {
    title: `Fix ${who} comment${file ? ` on ${file}` : ''}`,
    owner: 'junior',
    why: 'event',
    whyDetail: `${who} comment`,
    step: 'fix-thread',
    key: `thread:${t.id}`,
    input: { ...threadInput(t), ...(why ? { triage: why } : {}) },
  }
}

/** A thread the triage task can take: open, from one of the five review bots, and new to the watch. */
function triageable(t: PrThread, w: BabysitWatch): boolean {
  return !!findingOf(t) && !w.botThreads?.includes(t.id) && !w.botPrints.includes(fingerprint(t))
}

/**
 * The PR's events with its new review-bot threads grouped into one
 * `bot_triage` event, where the first of them stood. A thread that came back
 * after a fix stays a `bot_thread` (it goes to you, as before); so does any
 * other bot's thread (a fix task straight away). Past MAX_TRIAGE_THREADS the
 * rest are left out: the next poll takes them.
 */
export function batchBotThreads(evs: readonly BabysitEvent[], w: BabysitWatch): BabysitEvent[] {
  const out: BabysitEvent[] = []
  const fresh: PrThread[] = []
  let at = -1
  for (const ev of evs) {
    if (ev.kind === 'bot_thread' && triageable(ev.thread, w)) {
      if (fresh.length >= MAX_TRIAGE_THREADS) continue
      if (at < 0) at = out.length
      fresh.push(ev.thread)
      continue
    }
    out.push(ev)
  }
  if (fresh.length) out.splice(at, 0, { kind: 'bot_triage', threads: fresh })
  return out
}

/** FNV-1a, base 36: a short stable key for a set of thread ids. */
function shortHash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

/** "Triage 3 bot comments" / "Triage Bugbot comment on api.ts": one task for the batch. */
export function triageTask(threads: readonly PrThread[]): TaskSpec {
  const bots = [...new Set(threads.map((t) => botName(t.author)))]
  const one = threads.length === 1 ? threads[0]! : null
  const file = one ? fileOf(one.path) : null
  const ids = threads.map((t) => t.id).sort()
  return {
    title: one ? `Triage ${bots[0]} comment${file ? ` on ${file}` : ''}` : `Triage ${threads.length} bot comments`,
    owner: 'junior',
    why: 'event',
    whyDetail: `${threads.length} new ${threads.length === 1 ? 'comment' : 'comments'} from ${bots.join(', ')}`,
    step: TRIAGE_BOT_STEP,
    key: `triage:${ids.length}:${shortHash(ids.join(','))}`,
    input: {
      threads: threads.map((t) => {
        const f = findingOf(t)
        return { ...threadInput(t), ...(f ? { bot: f.bot, rule: f.rule, message: f.message } : {}) }
      }),
    },
  }
}

/** One thread as a triage task carries it: enough to judge it, and to fix it after. */
export type TriageThread = PrThread & { bot?: Bot; rule?: string; message?: string }

/** A triage task's threads, read back from its input. Anything malformed is dropped. */
export function triageThreadsOf(input: Record<string, unknown> | undefined): TriageThread[] {
  const raw = Array.isArray(input?.threads) ? (input.threads as unknown[]) : []
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const out: TriageThread[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = str(o.threadId)
    if (!id) continue
    out.push({
      id,
      author: str(o.author) ?? '',
      isBot: true,
      resolved: false,
      path: str(o.path),
      ...(typeof o.line === 'number' && Number.isInteger(o.line) && o.line > 0 ? { line: o.line } : {}),
      body: str(o.body) ?? '',
      url: str(o.url),
      ...(str(o.bot) ? { bot: o.bot as Bot } : {}),
      ...(str(o.rule) ? { rule: o.rule as string } : {}),
      ...(str(o.message) ? { message: o.message as string } : {}),
    })
  }
  return out
}

export type TriageResult = {
  /** one per thread, in the task's order: unsure, malformed or missing is a fix */
  verdicts: Verdict[]
  /** a fix-thread task per fix verdict */
  fixes: TaskSpec[]
  /** the task's line: "2 to fix, 1 won't fix, 1 incorrect" */
  summary: string
}

/** What Junior handed in for a triage task → the verdicts, the fix tasks and the line. */
export function triageResult(threads: readonly TriageThread[], raw: readonly unknown[]): TriageResult {
  const verdicts = verdictsFor(threads.map((t) => ({ threadId: t.id })), raw)
  const byId = new Map(threads.map((t) => [t.id, t]))
  const fixes = verdicts.flatMap((v) => (v.verdict === 'fix' && byId.has(v.threadId) ? [fixThreadTask(byId.get(v.threadId)!, v.why)] : []))
  const n = (k: Verdict['verdict']) => verdicts.filter((v) => v.verdict === k).length
  const parts = [n('fix') ? `${n('fix')} to fix` : '', n('wont-fix') ? `${n('wont-fix')} won't fix` : '', n('incorrect') ? `${n('incorrect')} incorrect` : ''].filter(Boolean)
  return { verdicts, fixes, summary: parts.join(', ') || 'no comments to sort' }
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

/**
 * Something is moving: a check is still running, Junior has work queued or
 * running, a head moved since the last poll (a push whose checks haven't
 * reported yet, so the hand-back gate is read again soon, not in 5 minutes),
 * or a fix waits out your push's grace window (`waiting`), so it starts on time.
 */
export function pollSoon(prs: readonly BabysitPr[], busy: boolean, moved = false, waiting = false): boolean {
  return busy || moved || waiting || prs.some((p) => p.checks.some((c) => c.status === 'pending'))
}
