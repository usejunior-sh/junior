/**
 * What you do with a first pass from the item page: post it (as you edited
 * it), or have Junior read the PR again. Posting is the one send of the
 * review playbook, and only your OK sends it: no advance approval covers it
 * in M3. It lands in Junior's log under Sent like any send.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { recordFor } from '../../core/actions/track.js'
import type { ActionRecord } from '../../core/actions/types.js'
import type { FirstPass } from '../../core/review/brief.js'
import { diffLines, postedLine, postEditFrom, reviewPayload, type ReviewPayload } from '../../core/review/post.js'
import { POST_REVIEW_STEP, REVIEW_STEP } from '../../core/review/watch.js'
import type { ItemTask } from '../../core/work/tasks.js'
import { gh } from '../babysit/glue.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { onActionChain } from '../session/actions-hold.js'
import { actionsChanged } from '../session/actions-record.js'
import { prOfItem, pumpTasks, tasksChanged } from '../tasks/runner.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { REVIEW_WATCH_KEY, type ReviewWatchState } from './watch.js'

const passOf = (t: ItemTask): FirstPass | null => {
  const p = t.input?.pass as FirstPass | undefined
  return p && typeof p.sha === 'string' && Array.isArray(p.comments) ? p : null
}

/** The PR's diff as of the head the pass read: comments are anchored there. */
async function diffAt(pr: { repo: string; number: number }, sha: string): Promise<string> {
  const base = (await gh(['api', `repos/${pr.repo}/pulls/${pr.number}`, '--jq', '.base.sha'])).trim()
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('could not read the PR’s base')
  return gh(['api', '-H', 'Accept: application/vnd.github.diff', `repos/${pr.repo}/compare/${base}...${sha}`])
}

/** You OK'd the review on the card: it goes out, as the card showed it. */
export async function postReviewOp(rt: WorkspaceRuntime, taskId: string, raw: unknown): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== POST_REVIEW_STEP || t.state !== 'waiting') throw new Error('only a waiting review can be posted')
  const pr = prOfItem(t.itemId)
  const pass = passOf(t)
  if (!pr || !pass) throw new Error('this task has no review to post')
  const edit = postEditFrom(raw)
  // Built before the claim: a review GitHub would refuse never leaves the card.
  const { payload, folded } = reviewPayload(pass, edit, diffLines(await diffAt(pr, pass.sha)))
  // Claim it first, so a double click posts once.
  if (!(await rt.store.tasks.move(t.id, 'queued', {}, Date.now()))) throw new Error('the task moved on before it could be posted')
  const at = Date.now()
  const dir = mkdtempSync(path.join(tmpdir(), 'triage-review-'))
  const file = path.join(dir, 'review.json')
  const command = `gh api -X POST repos/${pr.repo}/pulls/${pr.number}/reviews --input review.json`
  let url: string | null = null
  try {
    writeFileSync(file, JSON.stringify(payload))
    const res = JSON.parse(await gh(['api', '-X', 'POST', `repos/${pr.repo}/pulls/${pr.number}/reviews`, '--input', file])) as { html_url?: string }
    url = res.html_url ?? null
  } catch (err) {
    await rt.store.tasks.move(t.id, 'waiting', { error: errText(err) }, Date.now())
    await record(rt, t, pr, payload, command, at, null, errText(err))
    tasksChanged(rt)
    throw err
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  await rt.store.tasks.move(t.id, 'running', {}, Date.now())
  const summary = `${postedLine(payload)}${folded ? ` (${folded} off the diff, in the body)` : ''}`
  const done = await rt.store.tasks.move(t.id, 'done', { output: { summary, sha: pass.sha, verdict: edit.verdict ?? pass.verdict } }, Date.now())
  await rt.store.items.addDecision(t.itemId, { at: Date.now(), by: 'you', text: summary, taskId: t.id })
  await record(rt, t, pr, payload, command, at, url, null)
  log('info', 'review', `${summary} on ${pr.repo}#${pr.number}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  return done!
}

/** The review as an action record, so Junior's log lists it under Sent with who allowed it. */
async function record(rt: WorkspaceRuntime, t: ItemTask, pr: { repo: string; number: number }, p: ReviewPayload, command: string, at: number, url: string | null, error: string | null): Promise<void> {
  const now = Date.now()
  const rec: ActionRecord = {
    ...recordFor(
      { sessionId: `task-${t.id}`, sessionKind: 'task', permissionMode: null, jobId: null, teamRunId: null, itemId: t.itemId },
      `review-${at}`,
      'Bash',
      { command },
      { kind: 'comment', why: 'bash pattern', whyDetail: 'gh api pulls reviews', summary: `${postedLine(p).replace(/^Posted: /, 'Review: ')} on ${pr.repo}#${pr.number}` },
      at,
    ),
    status: error ? 'failed' : 'succeeded',
    link: url ?? `https://github.com/${pr.repo}/pull/${pr.number}`,
    error,
    allowedBy: 'prompt',
    allowedDetail: 'on the item page',
    settledAt: now,
    updatedAt: now,
  }
  await onActionChain(rt, () => rt.store.actions.put(rec))
    .then(() => actionsChanged(rt, new Set([rec.sessionId])))
    .catch((err) => log('warn', 'review', `could not record the review: ${errText(err)}`, { task: t.id, workspace: rt.meta.id }))
}

/**
 * Read the PR again: the unposted review is set aside and a fresh pass is
 * queued at the head as it is now. From the card, or a done pass's row.
 */
export async function reviewAgainOp(rt: WorkspaceRuntime, taskId: string): Promise<ItemTask> {
  const t = await rt.store.tasks.get(taskId)
  if (!t) throw new Error('no such task')
  if (t.step !== POST_REVIEW_STEP && t.step !== REVIEW_STEP) throw new Error('only a review can be run again')
  if (!prOfItem(t.itemId)) throw new Error('this task is not on a GitHub PR')
  const head = (await rt.store.config.get<ReviewWatchState>(REVIEW_WATCH_KEY))?.prs[t.itemId]
  if (!head) throw new Error('this PR no longer asks for your review')
  for (const o of await rt.store.tasks.list(t.itemId)) {
    if (o.step === REVIEW_STEP && (o.state === 'queued' || o.state === 'running')) throw new Error('a pass is already on its way')
    if (o.step === POST_REVIEW_STEP && o.state === 'waiting') await rt.store.tasks.move(o.id, 'skipped', { error: 'read again' }, Date.now())
  }
  const again = await rt.store.tasks.add(
    { itemId: t.itemId, title: 'Review first pass', owner: 'junior', why: 'you', whyDetail: 'read again', step: REVIEW_STEP, key: `review:again:${Date.now()}`, input: { sha: head.headSha, again: true } },
    Date.now(),
  )
  if (!again) throw new Error('could not add the pass')
  tasksChanged(rt)
  void pumpTasks(rt)
  return again
}

/** The head the review watch last read, for the card's "new commits since" line. No GitHub call. */
export async function reviewHeadOp(rt: WorkspaceRuntime, itemId: string): Promise<string | null> {
  return (await rt.store.config.get<ReviewWatchState>(REVIEW_WATCH_KEY))?.prs[itemId]?.headSha ?? null
}
