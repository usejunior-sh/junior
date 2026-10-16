/**
 * The PR shepherd (M5, .docs/goals/goals-engine.md "Default policies"): once a
 * goal opens a PR, a watcher in plain code — no model — polls it through `gh`
 * and turns what it sees into steps, until the PR is merged.
 *
 *   assess(snapshot, watch)   what's new on the PR, each thing keyed so it is acted on once
 *   policyFor(event, watch)   what the engine does about it, with the caps applied
 *   afterDecision / nextPoll  the watch's memory and its back-off
 *
 * A plan opts in with a `shepherd-pr` block step, which expands into a gate
 * the watcher owns (evaluator `watcher`: the AI sweep never checks it). The
 * policies ride in the plan the user approves, so what the engine does on its
 * own is something they read first.
 *
 * Pure — no I/O, no clock. The server fetches (server/goals.ts ghPrSource)
 * and carries the decisions out (goalWatchPrsOp).
 */
import { MAX_FIX_ATTEMPTS, type GateSpec } from './types.js'

// ---------------------------------------------------------------------------
// What the watcher reads
// ---------------------------------------------------------------------------

/** A PR: `owner/repo` and its number. */
export type PrRef = { repo: string; number: number }

/** One check on the head commit, folded from a check run or a status context. */
export type PrCheck = {
  name: string
  status: 'pending' | 'success' | 'failure' | 'neutral'
  /** changes when the check runs again (a check run's id), so a rerun's failure is new */
  id: string
  /** the Actions run behind it — for `gh run view --log-failed` and a rerun; null for a status context */
  runId: number | null
  url: string | null
  /** GitHub's own word for how it ended (TIMED_OUT, CANCELLED, …), for the flake test */
  conclusion: string | null
}

/** One review thread: who opened it, and whether it is resolved. */
export type PrThread = { id: string; author: string; isBot: boolean; resolved: boolean; path: string | null; body: string; url: string | null }

export type PrSnapshot = {
  repo: string
  number: number
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headSha: string
  baseRef: string
  headRef: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  /** null = the repo requires no review */
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  checks: PrCheck[]
  threads: PrThread[]
  /** who closed it, when it is closed */
  closedBy: string | null
}

/** One poll's read of a PR: state, head, mergeability, review, checks on the head commit, review threads. */
export const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url state headRefOid headRefName baseRefName mergeable reviewDecision
      timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
        ... on StatusContext { id context state targetUrl createdAt }
      } } } } } }
      reviewThreads(first: 100) { nodes { id isResolved path comments(first: 1) { nodes { url body author { __typename login } } } } }
    }
  }
}`

type J = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE', 'ERROR'])

function checkFrom(n: J): PrCheck | null {
  if (n?.__typename === 'CheckRun') {
    const done = n.status === 'COMPLETED'
    const c = String(n.conclusion ?? '')
    const status: PrCheck['status'] = !done ? 'pending' : c === 'SUCCESS' ? 'success' : c === 'NEUTRAL' || c === 'SKIPPED' ? 'neutral' : 'failure'
    return { name: String(n.name), status, id: String(n.databaseId), runId: n.checkSuite?.workflowRun?.databaseId ?? null, url: n.detailsUrl ?? null, conclusion: c || null }
  }
  if (n?.__typename === 'StatusContext') {
    const st = String(n.state)
    const status: PrCheck['status'] = st === 'SUCCESS' ? 'success' : FAILED.has(st) ? 'failure' : 'pending'
    return { name: String(n.context), status, id: `${n.id}:${n.createdAt}`, runId: null, url: n.targetUrl ?? null, conclusion: st }
  }
  return null
}

/** PR_QUERY's answer → a snapshot. Throws when the PR isn't there. */
export function snapshotFrom(pr: PrRef, data: J): PrSnapshot {
  const p = data?.data?.repository?.pullRequest
  if (!p) throw new Error(`PR ${pr.repo}#${pr.number} not found`)
  const rollup = p.commits?.nodes?.[0]?.commit?.statusCheckRollup
  const checks = ((rollup?.contexts?.nodes ?? []) as J[]).map(checkFrom).filter((c): c is PrCheck => c !== null)
  const threads: PrThread[] = ((p.reviewThreads?.nodes ?? []) as J[]).map((t) => {
    const c = t.comments?.nodes?.[0] ?? {}
    const login = String(c.author?.login ?? 'ghost')
    return { id: String(t.id), author: login, isBot: c.author?.__typename === 'Bot' || login.endsWith('[bot]'), resolved: !!t.isResolved, path: t.path ?? null, body: String(c.body ?? ''), url: c.url ?? null }
  })
  const state = p.state === 'MERGED' || p.state === 'CLOSED' ? p.state : 'OPEN'
  const mergeable = p.mergeable === 'MERGEABLE' || p.mergeable === 'CONFLICTING' ? p.mergeable : 'UNKNOWN'
  const review = ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(p.reviewDecision) ? p.reviewDecision : null
  return {
    repo: pr.repo,
    number: pr.number,
    url: String(p.url ?? ''),
    state,
    headSha: String(p.headRefOid ?? ''),
    baseRef: String(p.baseRefName ?? ''),
    headRef: String(p.headRefName ?? ''),
    mergeable,
    reviewDecision: review,
    checks,
    threads,
    closedBy: p.timelineItems?.nodes?.[0]?.actor?.login ?? null,
  }
}

/** A PR reference out of a gate's refs: a PR URL, `owner/repo#12`, `github:owner/repo#12`, or `#12` in `repo`. */
export function prRefFrom(refs: readonly string[], repo: string | null): PrRef | null {
  for (const r of refs) {
    const s = r.trim()
    const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(s)
    if (url) return { repo: url[1]!, number: Number(url[2]) }
    const full = /^(?:github:)?([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s)
    if (full) return { repo: full[1]!, number: Number(full[2]) }
    const bare = /^(?:#|PR\s*#?)?(\d+)$/i.exec(s)
    if (bare && repo) return { repo, number: Number(bare[1]) }
  }
  return null
}

// ---------------------------------------------------------------------------
// The default policies (the table in goals-engine.md)
// ---------------------------------------------------------------------------

export type PolicyId = 'push' | 'checks_failed' | 'bot_thread' | 'human_thread' | 'bot_repeat' | 'conflict' | 'ready' | 'closed' | 'budget'

/** The table, as the plan shows it. Budget is enforced by the scheduler (core/goals/run.ts budgetCheck). */
export const DEFAULT_POLICIES: readonly { id: PolicyId; on: string; does: string }[] = [
  { id: 'push', on: 'Any push', does: 'wait for the checks on the new head commit' },
  { id: 'checks_failed', on: 'Checks failed', does: `a fix step (the failing check, its log, the diff, the handoff); a check that looks flaky is rerun once first; after ${MAX_FIX_ATTEMPTS} fixes, ask the user` },
  { id: 'bot_thread', on: 'New bot review thread', does: 'fix, push, reply, resolve — or reply why not and ask the user' },
  { id: 'human_thread', on: 'New human review thread', does: 'fix it; the reply waits in the Outbox' },
  { id: 'bot_repeat', on: 'Same bot comment comes back', does: 'ask the user; no third attempt' },
  { id: 'conflict', on: 'Merge conflict', does: 'a rebase step' },
  { id: 'ready', on: 'Green, approved, no open threads', does: 'a merge step; the merge waits in the Outbox for your approval' },
  { id: 'closed', on: 'PR closed by someone else', does: 'ask the user' },
  { id: 'budget', on: 'Budget 80% used', does: 'tell the user; at 100%, pause and ask' },
]

/** The plan's Policies section. */
export const policyLines = (): string[] => DEFAULT_POLICIES.map((p) => `${p.on}: ${p.does}`)

/** The block a plan names to have its PR shepherded. */
export const SHEPHERD_BLOCK = 'shepherd-pr'

/** What a `shepherd-pr` block step's gate waits for. Deterministic, so one "merged" is enough. */
export const SHEPHERD_GATE: GateSpec = {
  evaluator: 'watcher',
  condition: 'the PR is merged — the watcher fixes CI, review threads and conflicts on the way, and the merge waits for your approval',
  checkEvery: null,
  deadline: '3d',
  confirmations: 1,
  connectors: [],
}

// ---------------------------------------------------------------------------
// The watch: what the watcher remembers between polls
// ---------------------------------------------------------------------------

export type PrWatch = {
  /** the gate it serves; a new gate on the goal starts the back-off over */
  gateId: string
  pr: PrRef | null
  headSha: string | null
  /** keys of the events already acted on */
  seen: string[]
  /** fix steps dispatched per failing check, by check name */
  fixes: Record<string, number>
  /** `check@sha` reruns spent: one each */
  reruns: string[]
  /** fingerprints of the bot comments already fixed */
  botPrints: string[]
  /** the steps the watcher added to the plan */
  steps: string[]
  /** polls in a row that found nothing new: the back-off index */
  quiet: number
  nextPollAt: number
  /** gh failures in a row */
  errors: number
}

export const newWatch = (gateId: string, at: number): PrWatch => ({
  gateId,
  pr: null,
  headSha: null,
  seen: [],
  fixes: {},
  reruns: [],
  botPrints: [],
  steps: [],
  quiet: 0,
  nextPollAt: at,
  errors: 0,
})

/** Minutes between polls after something happened: fast while CI runs, then every 15. */
export const WATCH_POLL_SCHEDULE_MIN: readonly number[] = [1, 1, 2, 2, 5, 5, 10, 10]
export const WATCH_POLL_TAIL_MIN = 15
/** The watcher's timer. */
export const WATCH_TICK_MS = 60_000
/** Remembered keys past this are dropped, oldest first. */
const MAX_SEEN = 500

export const pollDelay = (quiet: number): number => (WATCH_POLL_SCHEDULE_MIN[quiet] ?? WATCH_POLL_TAIL_MIN) * 60_000

/** The next poll: back to the fast end when something happened, one step slower when nothing did. */
export function nextPoll(w: PrWatch, changed: boolean, at: number): PrWatch {
  const quiet = changed ? 0 : w.quiet + 1
  return { ...w, quiet, nextPollAt: at + pollDelay(quiet) }
}

// ---------------------------------------------------------------------------
// What's new on the PR
// ---------------------------------------------------------------------------

export type WatcherEvent =
  | { kind: 'pushed'; key: string; sha: string; from: string | null }
  | { kind: 'checks_failed'; key: string; sha: string; check: PrCheck }
  | { kind: 'bot_thread'; key: string; thread: PrThread }
  | { kind: 'human_thread'; key: string; thread: PrThread }
  | { kind: 'conflict'; key: string; sha: string }
  | { kind: 'ready'; key: string; sha: string }
  | { kind: 'closed'; key: string; by: string | null }
  | { kind: 'merged'; key: string }

/** Every check finished green (or neutral), none failing or pending. */
const green = (s: PrSnapshot) => s.checks.every((c) => c.status === 'success' || c.status === 'neutral')

/** Ready to merge: open, green, approved (or no review required), no open thread, no conflict. */
export const isReady = (s: PrSnapshot) =>
  s.state === 'OPEN' && green(s) && (s.reviewDecision === 'APPROVED' || s.reviewDecision === null) && !s.threads.some((t) => !t.resolved) && s.mergeable === 'MERGEABLE'

/** What the snapshot shows that the watch hasn't acted on yet, in the order to act on it. */
export function assess(s: PrSnapshot, w: Pick<PrWatch, 'seen' | 'headSha'>): WatcherEvent[] {
  const fresh = (key: string) => !w.seen.includes(key)
  if (s.state === 'MERGED') return fresh('merged') ? [{ kind: 'merged', key: 'merged' }] : []
  if (s.state === 'CLOSED') {
    const key = `closed:${s.headSha}`
    return fresh(key) ? [{ kind: 'closed', key, by: s.closedBy }] : []
  }
  const out: WatcherEvent[] = []
  const sha = s.headSha
  if (sha !== w.headSha && fresh(`push:${sha}`)) out.push({ kind: 'pushed', key: `push:${sha}`, sha, from: w.headSha })
  for (const check of s.checks) {
    const key = `fail:${sha}:${check.name}:${check.id}`
    if (check.status === 'failure' && fresh(key)) out.push({ kind: 'checks_failed', key, sha, check })
  }
  for (const thread of s.threads) {
    const key = `thread:${thread.id}`
    if (!thread.resolved && fresh(key)) out.push({ kind: thread.isBot ? 'bot_thread' : 'human_thread', key, thread })
  }
  if (s.mergeable === 'CONFLICTING' && fresh(`conflict:${sha}`)) out.push({ kind: 'conflict', key: `conflict:${sha}`, sha })
  if (isReady(s) && fresh(`ready:${sha}`)) out.push({ kind: 'ready', key: `ready:${sha}`, sha })
  return out
}

/** A bot comment, minus what changes between runs (numbers, hashes, spacing): the same finding prints the same. */
export function fingerprint(t: Pick<PrThread, 'author' | 'path' | 'body'>): string {
  const body = t.body
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
  return `${t.author.toLowerCase()}|${t.path ?? ''}|${body}`
}

/** A failure that a rerun may clear: a timeout, a dropped connection, a runner that went away. */
const FLAKY = /\b(timed? ?out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|rate limit(ed)?|50[234]\b|service unavailable|runner (has received a shutdown|lost communication)|network (error|unreachable)|flak(y|e))\b/i

export const looksFlaky = (log: string): boolean => FLAKY.test(log)

// ---------------------------------------------------------------------------
// The policy for each event
// ---------------------------------------------------------------------------

export type ShepherdStep = 'fix_ci' | 'fix_thread' | 'rebase' | 'merge'

export type PolicyDecision =
  /** nothing to run: say so on the goal and keep watching (a push: the gate is the wait on its checks) */
  | { do: 'note'; policy: PolicyId; text: string }
  | { do: 'rerun'; policy: 'checks_failed'; check: PrCheck; text: string }
  | { do: 'step'; policy: PolicyId; step: ShepherdStep; stepId: string; title: string; doneWhen: string; text: string }
  | { do: 'ask_user'; policy: PolicyId; question: string; recommended: string; evidence: string | null }
  /** the PR merged: the shepherd gate is met */
  | { do: 'resolve'; policy: null; text: string }

/** A step id for the plan from free text: short, and only the characters plan step ids allow. */
const slug = (s: string, max: number) =>
  s
    .toLowerCase()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'x'

export const stepIdFor = (step: ShepherdStep, about = ''): string =>
  step === 'fix_ci' ? `pr-ci-${slug(about, 34)}` : step === 'fix_thread' ? `pr-thread-${slug(about, 30).slice(-12)}` : step === 'rebase' ? 'pr-rebase' : 'pr-merge'

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * What the engine does about one event. `log` is the failing check's output,
 * for a failed check (the flake test). The caps: a check fixed
 * MAX_FIX_ATTEMPTS times goes to the user, and so does a bot comment that
 * comes back after it was fixed.
 */
export function policyFor(ev: WatcherEvent, w: Pick<PrWatch, 'fixes' | 'reruns' | 'botPrints'>, pr: PrRef, log = ''): PolicyDecision {
  const prName = `${pr.repo}#${pr.number}`
  switch (ev.kind) {
    case 'pushed':
      return { do: 'note', policy: 'push', text: `New head ${ev.sha.slice(0, 7)} on ${prName}: waiting for its checks` }
    case 'checks_failed': {
      const name = ev.check.name
      const flaky = looksFlaky(log) || /^(TIMED_OUT|CANCELLED|STARTUP_FAILURE)$/.test(ev.check.conclusion ?? '')
      if (ev.check.runId !== null && flaky && !w.reruns.includes(`${name}@${ev.sha}`))
        return { do: 'rerun', policy: 'checks_failed', check: ev.check, text: `${name} failed on ${ev.sha.slice(0, 7)} and looks flaky: rerunning it once` }
      const tries = w.fixes[name] ?? 0
      if (tries >= MAX_FIX_ATTEMPTS)
        return {
          do: 'ask_user',
          policy: 'checks_failed',
          question: `${name} still fails on ${prName} after ${tries} fixes. What should Junior do?`,
          recommended: 'Look at the failure yourself, then tell Junior what to change — or to stop and leave the PR to you',
          evidence: clip(log.trim(), 2_000) || ev.check.url,
        }
      return {
        do: 'step',
        policy: 'checks_failed',
        step: 'fix_ci',
        stepId: stepIdFor('fix_ci', name),
        title: `Fix CI: ${clip(name, 80)}`,
        doneWhen: `a fix for the failing check "${clip(name, 120)}" is committed and pushed to the PR branch`,
        text: `${name} failed on ${ev.sha.slice(0, 7)}: fix ${tries + 1} of ${MAX_FIX_ATTEMPTS}`,
      }
    }
    case 'bot_thread':
      if (w.botPrints.includes(fingerprint(ev.thread)))
        return {
          do: 'ask_user',
          policy: 'bot_repeat',
          question: `${ev.thread.author} raised the same comment again on ${prName} after Junior fixed it${ev.thread.path ? ` (${ev.thread.path})` : ''}. What should Junior do?`,
          recommended: "Read it: if it's a false positive, say so and Junior replies with the reasoning; otherwise say what to change",
          evidence: clip(ev.thread.body, 2_000),
        }
      return threadStep(ev.thread, 'bot_thread')
    case 'human_thread':
      return threadStep(ev.thread, 'human_thread')
    case 'conflict':
      return { do: 'step', policy: 'conflict', step: 'rebase', stepId: stepIdFor('rebase'), title: 'Rebase the PR', doneWhen: 'the PR branch is rebased onto its base with no conflicts, tests pass, and it is pushed', text: `${prName} has a merge conflict: rebasing` }
    case 'ready':
      return { do: 'step', policy: 'ready', step: 'merge', stepId: stepIdFor('merge'), title: 'Merge the PR', doneWhen: 'the merge is queued for the user\'s approval', text: `${prName} is green, approved and has no open threads: the merge goes to you` }
    case 'closed':
      return {
        do: 'ask_user',
        policy: 'closed',
        question: `${prName} was closed${ev.by ? ` by ${ev.by}` : ''} without merging. What should Junior do?`,
        recommended: 'Find out why it was closed; tell Junior to reopen it, open a new PR, or stop',
        evidence: null,
      }
    case 'merged':
      return { do: 'resolve', policy: null, text: `${prName} is merged` }
  }
}

function threadStep(t: PrThread, policy: 'bot_thread' | 'human_thread'): PolicyDecision {
  return {
    do: 'step',
    policy,
    step: 'fix_thread',
    stepId: stepIdFor('fix_thread', t.id),
    title: `Review thread from ${clip(t.author, 40)}${t.path ? ` on ${clip(t.path, 60)}` : ''}`,
    doneWhen: policy === 'bot_thread' ? 'the finding is fixed, pushed, replied to and resolved — or answered with the reasoning why not' : 'the change asked for is committed and pushed, and the reply is queued',
    text: `New ${policy === 'bot_thread' ? 'bot' : 'review'} thread from ${t.author}${t.path ? ` on ${t.path}` : ''}`,
  }
}

/** The watch once `d` was carried out for `ev`: the event is acted on, the caps count it. */
export function afterDecision(w: PrWatch, ev: WatcherEvent, d: PolicyDecision): PrWatch {
  const out: PrWatch = { ...w, seen: [...w.seen, ev.key].slice(-MAX_SEEN) }
  if (d.do === 'rerun' && ev.kind === 'checks_failed') out.reruns = [...w.reruns, `${ev.check.name}@${ev.sha}`].slice(-MAX_SEEN)
  if (d.do === 'step') {
    if (!w.steps.includes(d.stepId)) out.steps = [...w.steps, d.stepId]
    if (d.step === 'fix_ci' && ev.kind === 'checks_failed') out.fixes = { ...w.fixes, [ev.check.name]: (w.fixes[ev.check.name] ?? 0) + 1 }
    if (ev.kind === 'bot_thread') out.botPrints = [...w.botPrints, fingerprint(ev.thread)].slice(-MAX_SEEN)
  }
  return out
}

// ---------------------------------------------------------------------------
// The steps' briefs: what a worker gets beyond the plan and the handoff
// ---------------------------------------------------------------------------

/** How much of a CI log or a diff goes into a brief: the end of a log, the start of a diff. */
export const BRIEF_LOG_CHARS = 12_000
export const BRIEF_DIFF_CHARS = 12_000

const tail = (s: string, n: number) => (s.length > n ? `…(earlier output cut)\n${s.slice(-n)}` : s)
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(rest of the diff cut: run \`gh pr diff\`)` : s)

export function fixCiBrief(pr: PrRef, check: PrCheck, attempt: number, log: string, diff: string): string {
  return [
    `CI check "${check.name}" fails on PR ${pr.repo}#${pr.number}. Fix it — try ${attempt} of ${MAX_FIX_ATTEMPTS}; after that the user is asked.`,
    check.url ? `Check: ${check.url}` : '',
    '',
    'Find the cause in the log below, fix it in this worktree, run the failing test locally, commit, and push the PR branch.',
    "Fix the cause, not the test: don't skip, weaken or delete a test to make it pass. If the failure isn't caused by this PR, log the step blocked and say why.",
    '',
    '## Failing log (`gh run view --log-failed`)',
    '```',
    tail(log.trim(), BRIEF_LOG_CHARS) || '(no log came back: open the check link)',
    '```',
    '',
    '## The PR diff',
    '```diff',
    head(diff.trim(), BRIEF_DIFF_CHARS) || '(no diff came back: run `gh pr diff`)',
    '```',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}

export function threadBrief(pr: PrRef, t: PrThread): string {
  const reply = `gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}' -f id=${t.id} -f body='<your reply>'`
  const resolve = `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=${t.id}`
  return [
    `A review thread on PR ${pr.repo}#${pr.number} from ${t.author} (${t.isBot ? 'a bot' : 'a person'})${t.path ? ` on ${t.path}` : ''}:`,
    t.url ?? '',
    '',
    ...t.body.trim().split('\n').map((l) => `> ${l}`),
    '',
    t.isBot
      ? [
          'Decide whether the finding is valid.',
          `- Valid: fix it, commit, push, reply on the thread with what changed (\`${reply}\`), then resolve it (\`${resolve}\`).`,
          "- A false positive: reply with your reasoning, don't resolve it, and log the step blocked so the user decides.",
        ].join('\n')
      : [
          'A person asked for this. Make the change, commit and push, then reply on the thread with what you changed:',
          `\`${reply}\``,
          "Your reply is held in the Outbox for the user to approve, word for word: write it as they'd want it sent. Don't resolve a person's thread.",
        ].join('\n'),
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
}

export function rebaseBrief(pr: PrRef, s: Pick<PrSnapshot, 'baseRef' | 'headRef'>): string {
  return [
    `PR ${pr.repo}#${pr.number} conflicts with ${s.baseRef}. Rebase ${s.headRef} onto origin/${s.baseRef}:`,
    `\`git fetch origin ${s.baseRef} && git rebase origin/${s.baseRef}\`, resolve each conflict keeping both sides' intent, run the tests,`,
    'then `git push --force-with-lease`. If a conflict needs a product decision, abort the rebase and log the step blocked with the question.',
  ].join('\n')
}

export function mergeBrief(pr: PrRef): string {
  return [
    `PR ${pr.repo}#${pr.number} is green, approved and has no open threads.`,
    `Run \`gh pr merge ${pr.number} -R ${pr.repo} --squash\` and nothing else. It is held for the user's approval — that approval is the merge.`,
    'When you are told it was queued, log the step done.',
  ].join('\n')
}
