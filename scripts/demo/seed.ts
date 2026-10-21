// Seed a fake demo world (scripts/demo/world.ts) into its own TRIAGE_HOME, for
// marketing screenshots. Writes straight to the store with no server running:
// the server reads sessions, links and team runs into memory at boot.
//
//   tsx scripts/demo/seed.ts [--home ~/.triage-demo]
//
// The home is wiped and rebuilt on every run, so the data is always relative to
// now. It refuses to touch a folder it didn't create (no `.demo-home` marker),
// and refuses while a server is answering on it.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../../core/store/sqlite.js'
import { builtinGrant, type BuiltinToolId } from '../../core/job/tools.js'
import { nextScheduled } from '../../core/job/cron.js'
import { serializeFrontmatter } from '../../server/artifacts.js'
import type { ActionRecord } from '../../core/actions/types.js'
import type { SessionEvent } from '../../shared/protocol.js'
import type { Store } from '../../core/store/types.js'
import type { WorkItem } from '../../core/work/types.js'
import type { Stage, Turn } from '../../core/work/flow.js'
import * as W from './world.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MARKER = '.demo-home'

export const DEFAULT_HOME = path.join(os.homedir(), '.triage-demo')

// A settable clock: every store write stamps Date.now(), so pointing it at the
// past is how rows get believable times without patching SQL afterwards.

const realNow = Date.now.bind(Date)
let clock: number | null = null
Date.now = () => clock ?? realNow()
const at = (t: number) => {
  clock = Math.round(t)
}

export async function seed(home = DEFAULT_HOME): Promise<{ home: string; projectPath: string }> {
  home = path.resolve(home)
  await guardHome(home)
  rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, MARKER), 'Demo data for marketing screenshots (scripts/demo). Safe to delete.\n')

  const now = realNow()
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  const dayAt = (offset: number) => new Date(midnight).setDate(new Date(midnight).getDate() + offset)
  // "landed today": a fraction of the way from midnight to now
  const today = (frac: number) => midnight + Math.max(MIN, frac * (now - midnight))

  writeFileSync(
    path.join(home, 'workspaces.json'),
    JSON.stringify(
      {
        version: 1,
        defaultId: 'default',
        onboarded: true,
        workspaces: [{ id: 'default', name: W.WORKSPACE_NAME, color: '#7aa2f7', provider: 'claude', authBackend: 'inherit', createdAt: now - 30 * DAY }],
      },
      null,
      2,
    ) + '\n',
  )
  const ws = path.join(home, 'workspaces', 'default')
  mkdirSync(ws, { recursive: true })

  const projectPath = path.join(home, 'projects', 'api')
  makeRepo(projectPath, now)

  const store = openSqliteStore(path.join(ws, 'triage.db'))
  try {
    at(now - 30 * DAY)
    await store.projects.create({ id: W.ID.project, name: 'api', repo: 'acme/api', path: projectPath })
    await store.projects.setDefault(W.ID.project)
    await store.config.set('github.repos', W.REPOS)
    await store.config.set('jobs.enabled', true)

    const lastRun = await seedJobs(store, ws, projectPath, now)
    await seedItems(store, now, dayAt, today, lastRun)
    await seedSessions(store, projectPath, now)
    await seedArtifacts(store, ws, now)
    await seedActions(store, now)

    at(now)
    // the sessions above already have their action records; don't fold them again at boot
    await store.config.set('actions_backfill', { at: now })
    for (const it of [...W.items(), ...W.manuals()]) {
      if (it.override) {
        await store.items.setFlowOverride(it.id, { ...it.override, stage: it.override.stage as Stage | undefined, turn: it.override.turn as Turn | undefined, at: now }, 'you')
      }
    }
  } finally {
    clock = null
    await store.close()
  }
  return { home, projectPath }
}

async function guardHome(home: string): Promise<void> {
  if (!existsSync(home)) return
  if (!existsSync(path.join(home, MARKER))) {
    throw new Error(`${home} exists and wasn't made by the demo seed (no ${MARKER}); pick another --home`)
  }
  const stateFile = path.join(home, 'server.json')
  if (!existsSync(stateFile)) return
  try {
    const { port } = JSON.parse(readFileSync(stateFile, 'utf8')) as { port?: number }
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    if (res.ok) throw new Error(`a server is running on ${home} (:${port}); stop it before re-seeding`)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('a server')) throw err
  }
}

/** A small real git repo, so paths, the branch chip and the Changes view are real. */
function makeRepo(dir: string, now: number): void {
  mkdirSync(dir, { recursive: true })
  for (const [rel, text] of Object.entries(W.REPO_FILES)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), text)
  }
  const date = new Date(now - 2 * DAY).toISOString()
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Alex Rivera',
    GIT_AUTHOR_EMAIL: 'alex@acme.dev',
    GIT_COMMITTER_NAME: 'Alex Rivera',
    GIT_COMMITTER_EMAIL: 'alex@acme.dev',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '--no-gpg-sign', '-m', 'Initial commit')
  git('remote', 'add', 'origin', 'git@github.com:acme/api.git')
  for (const [rel, text] of Object.entries(W.REPO_EDITS)) writeFileSync(path.join(dir, rel), text)
}

async function seedItems(
  store: Store,
  now: number,
  dayAt: (offset: number) => number,
  today: (frac: number) => number,
  lastRun: Map<string, string>,
): Promise<void> {
  for (const it of W.items()) {
    at(now - it.ingested)
    const item: WorkItem = {
      id: it.id,
      source: it.source,
      kind: it.kind as WorkItem['kind'],
      title: it.title,
      url: it.url,
      repo: it.repo,
      author: it.author,
      peopleWaiting: it.peopleWaiting,
      createdAt: new Date(now - it.created).toISOString(),
      updatedAt: new Date(now - it.updated).toISOString(),
      ...(it.ciFailing ? { ciFailing: true } : {}),
      ...(it.isDraft ? { isDraft: true } : {}),
      ...(it.priority ? { priority: it.priority } : {}),
      ...(it.ask ? { ask: it.ask } : {}),
      ...(it.jobId ? { jobId: it.jobId } : {}),
      ...(it.why && !it.jobId ? { why: it.why } : {}),
      ...(it.dueInDays != null ? { dueAt: dayAt(it.dueInDays), dueSource: 'explicit' as const } : {}),
    }
    const prov = it.jobId ? { jobId: it.jobId, runId: lastRun.get(it.jobId), at: now - it.ingested, why: it.why } : undefined
    await store.items.upsert(item, prov)
    if (it.description) await store.items.setDescription(it.id, it.description)
    if (it.handoff || it.label) await store.items.setFields(it.id, { ...(it.handoff ? { handoff: it.handoff } : {}), ...(it.label ? { label: it.label } : {}) })
    if (it.status) await settle(store, it.id, it.status, now, today)
  }
  for (const m of W.manuals()) {
    at(now - m.created)
    await store.items.createManual({ id: m.id, title: m.title, description: m.description, priority: m.priority, projectId: W.ID.project })
    if (m.dueInDays != null) await store.items.setDue(m.id, { at: dayAt(m.dueInDays) })
    if (m.status) await settle(store, m.id, m.status, now, today)
  }
}

async function settle(
  store: Store,
  id: string,
  s: { to: 'done' | 'snoozed' | 'archived'; at: number; reason?: string },
  now: number,
  today: (frac: number) => number,
): Promise<void> {
  // done items land today: `at` is a fraction of the day so far; others are ms ago
  at(s.to === 'done' ? today(s.at) : now - s.at)
  await store.items.transition(id, {
    status: s.to,
    actor: 'you',
    ...(s.to === 'snoozed' ? { snoozeUntil: now + 3 * DAY } : {}),
    ...(s.reason ? { detail: { reason: s.reason } } : {}),
  })
}

/** Expand a transcript, appending events with times that advance like a real run. */
async function writeTranscript(store: Store, sessionId: string, model: string, steps: W.Step[], start: number, cwd: string): Promise<number> {
  let t = start
  let seq = 0
  let tool = 0
  let first = true
  const append = async (event: SessionEvent, advance: number) => {
    t += advance
    at(t)
    await store.events.append(sessionId, ++seq, event)
  }
  for (const step of steps) {
    if ('user' in step) {
      await append({ kind: 'local_user', text: step.user }, 0)
      if (first) {
        first = false
        await append(
          {
            kind: 'sdk',
            message: { type: 'system', subtype: 'init', cwd, model, tools: ['Bash', 'Read', 'Edit', 'Grep', 'Write'], mcp_servers: [{ name: 'triage', status: 'connected' }] },
          } as unknown as SessionEvent,
          1_000,
        )
      }
    } else if ('say' in step) {
      await append(assistant([{ type: 'text', text: step.say }]), 4_000 + step.say.length * 15)
    } else if ('tool' in step) {
      const id = step.id ?? `toolu_demo_${sessionId.slice(-4)}_${++tool}`
      await append(assistant([{ type: 'tool_use', id, name: step.tool, input: step.input }]), 2_500)
      await append(
        {
          kind: 'sdk',
          message: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: step.out, is_error: !!step.error }] } },
        } as unknown as SessionEvent,
        (step.secs ?? 1) * 1_000,
      )
    } else if ('done' in step) {
      await append(
        {
          kind: 'sdk',
          message: { type: 'result', subtype: 'success', is_error: false, duration_ms: t - start, num_turns: step.done.turns, total_cost_usd: step.done.cost },
        } as unknown as SessionEvent,
        500,
      )
    }
  }
  return t
}

const assistant = (content: unknown[]): SessionEvent =>
  ({ kind: 'sdk', message: { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content } } }) as unknown as SessionEvent

async function seedSessions(store: Store, cwd: string, now: number): Promise<void> {
  for (const s of W.sessions(cwd)) {
    const start = now - s.started
    at(start)
    const model = s.model ?? W.MODEL
    await store.sessions.create({ id: s.id, title: s.title, cwd, projectId: W.ID.project, model, permissionMode: 'auto' })
    if (s.itemId) await store.links.add({ fromKind: 'session', fromId: s.id, toKind: 'item', toId: s.itemId, role: 'dispatch' })
    const end = await writeTranscript(store, s.id, model, s.steps, start, cwd)
    at(end)
    await store.sessions.touch(s.id)
    if (s.pinned) await store.sessions.setPinned(s.id, true)
  }
}

// Jobs: files + rows + a week of run history (sessions and ledger rows)

/** The last `n` slots of a cron schedule before `now`, oldest first. */
function pastSlots(schedule: string, now: number, n: number): number[] {
  const out: number[] = []
  let t = nextScheduled(schedule, now - 60 * DAY)
  while (t != null && t < now) {
    out.push(t)
    t = nextScheduled(schedule, t)
  }
  return out.slice(-n)
}

const RUN_SUMMARY: Record<string, (n: number) => string> = {
  [W.ID.job.prSweep]: (n) => `Checked 23 open PRs across acme/api and acme/web. Filed ${n} where your review is requested.`,
  [W.ID.job.sentry]: (n) => (n ? `Found ${n} issue${n > 1 ? 's' : ''} above 10x baseline since the last deploy. Filed.` : 'No issue above 10x its baseline. Nothing filed.'),
  [W.ID.job.linear]: (n) => (n ? `${n} ticket${n > 1 ? 's' : ''} newly assigned to you in ACME. Filed.` : 'Nothing new assigned to you.'),
  [W.ID.job.deps]: (n) => `Reviewed 9 Dependabot PRs: 7 patch bumps with green CI skipped. Filed ${n}.`,
  [W.ID.job.escalations]: (n) => (n ? `${n} thread${n > 1 ? 's' : ''} in #support mention API errors with no engineer reply. Filed.` : 'No unanswered API escalations.'),
  [W.ID.job.digest]: () => 'Wrote this week\'s digest: 14 PRs merged across 4 areas.',
}

async function seedJobs(store: Store, ws: string, cwd: string, now: number): Promise<Map<string, string>> {
  const lastRun = new Map<string, string>()
  mkdirSync(path.join(ws, 'jobs'), { recursive: true })
  for (const j of W.jobs()) {
    const text = serializeFrontmatter(
      {
        id: j.id,
        title: j.title,
        schedule: j.schedule,
        project: W.ID.project,
        tools: j.tools,
        output: j.output,
        catch_up: 'never',
        notify: 'on_failure',
        enabled: String(j.enabled),
      },
      `\n${j.instruction}\n`,
    )
    writeFileSync(path.join(ws, 'jobs', `${j.file}.md`), text)

    at(now - 21 * DAY)
    await store.jobs.create({
      id: j.id,
      source: 'slack',
      title: j.title,
      scope: '',
      instruction: j.instruction,
      tools: j.tools.map((t) => builtinGrant(t as BuiltinToolId)),
      projectId: W.ID.project,
      catchUpWindow: 'never',
      file: j.file,
      notify: 'on_failure',
      output: j.output,
      schedule: j.schedule,
      cadence: 'daily',
      enabled: j.enabled,
      createsItems: j.output === 'items',
      consecutiveFailures: 0,
      createdAt: now - 21 * DAY,
      updatedAt: now - 21 * DAY,
    })

    const slots = pastSlots(j.schedule, now, j.runs.length)
    const runs = j.runs.slice(-slots.length)
    for (const [i, slot] of slots.entries()) {
      const matches = runs[i]
      const failed = matches == null
      const start = slot + 4_000
      const secs = failed ? 41 : 35 + ((i * 17) % 50)
      const cost = failed ? 0.02 : 0.04 + ((i * 7) % 9) / 100
      const sid = `${j.id.slice(0, 19)}${j.id.slice(-4)}-${String(i).padStart(12, '0')}`
      at(start)
      await store.sessions.create({ id: sid, title: `Job · ${j.title}`, cwd, projectId: W.ID.project, kind: 'job-run', jobId: j.id, runTrigger: 'scheduled', model: 'sonnet' })
      await store.jobs.markRunStarted(j.id, { startedAt: slot, trigger: 'scheduled', sessionId: sid })
      const steps: W.Step[] = failed
        ? [{ say: 'Sentry API returned 502 three times in a row; stopping without filing anything.' }]
        : [{ say: RUN_SUMMARY[j.id](matches ?? 0) }, { done: { turns: 4, cost } }]
      await writeTranscript(store, sid, 'sonnet', [{ user: `Run job: ${j.title}` }, ...steps], start, cwd)
      const end = start + secs * 1_000
      at(end)
      if (failed) await store.events.append(sid, 99, { kind: 'error', message: 'Sentry API: 502 Bad Gateway' } as SessionEvent)
      const status = failed ? 'failed' : 'ok'
      const tokens = 18_000 + matches! * 2_400
      await store.sessions.recordJobRun(sid, { status, matches: matches ?? 0, newCount: matches ?? 0, tokens: failed ? 6_000 : tokens, costUsd: cost, ...(failed ? { error: 'Sentry API: 502 Bad Gateway' } : {}) })
      await store.jobRuns.insert({ jobId: j.id, slot, trigger: 'scheduled', status, sessionId: sid, startedAt: start, endedAt: end, costUsd: cost, ...(failed ? { reason: 'Sentry API: 502 Bad Gateway' } : {}) })
      await store.jobs.recordRun(j.id, {
        lastRunAt: end,
        lastRunTokens: failed ? 6_000 : tokens,
        lastRunMatches: matches ?? 0,
        lastRunNew: matches ?? 0,
        status,
        trigger: 'scheduled',
        sessionId: sid,
        ...(failed ? { error: 'Sentry API: 502 Bad Gateway' } : {}),
      })
      lastRun.set(j.id, sid)
    }
  }
  return lastRun
}

// Artifacts: the file is the truth; rows and links make them show at once

async function seedArtifacts(store: Store, ws: string, now: number): Promise<void> {
  for (const a of W.artifacts()) {
    const updated = now - a.updated
    const file = path.join(ws, 'artifacts', a.path)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      serializeFrontmatter(
        { id: a.id, title: a.title, author: a.author, refs: a.refs, created: new Date(updated - 3 * MIN).toISOString(), updated: new Date(updated).toISOString() },
        `\n${a.body}`,
      ),
    )
    const st = statSync(file)
    at(updated)
    await store.artifacts.upsert({ id: a.id, path: a.path, title: a.title, author: a.author, refs: a.refs, created: updated - 3 * MIN, updated, mtime: st.mtimeMs, size: st.size, format: 'md', version: 1, history: true })
    if (!a.link) continue
    await store.links.add({ fromKind: 'artifact', fromId: a.id, toKind: 'item', toId: a.link.itemId, role: a.link.role })
    if (a.playbook) {
      at(updated - 3 * MIN)
      const job = await store.briefs.create({ id: `brief-${a.id.slice(-4)}`, itemId: a.link.itemId, playbook: a.playbook, model: 'sonnet' })
      at(updated)
      await store.briefs.update(job.id, { status: 'ready', artifactId: a.id, startedAt: updated - 3 * MIN, finishedAt: updated })
    }
  }
}

// Actions: what the agents did (or want to do) out in the world

async function seedActions(store: Store, now: number): Promise<void> {
  const base = {
    error: null,
    whyDetail: null,
    allowedDetail: null,
    jobId: null,
    teamRunId: null,
    groupKey: null,
    count: 1,
  }
  const rec = (r: Omit<ActionRecord, keyof typeof base | 'calls' | 'updatedAt'> & Partial<ActionRecord>): ActionRecord => {
    const toolUse = r.id.split(':')[1]
    return { ...base, calls: [toolUse], updatedAt: r.settledAt ?? r.attemptedAt, ...r }
  }
  const t = (ago: number) => now - ago
  const records: ActionRecord[] = [
    rec({
      id: `${W.ID.s.replyPriya}:toolu_demo_slack`,
      sessionId: W.ID.s.replyPriya,
      sessionKind: 'chat',
      tool: 'mcp__claude_ai_Slack__slack_send_message',
      kind: 'message',
      summary: 'Reply to Priya in #eng-payments: "Yes, Friday works…"',
      args: {
        channel_id: 'C04ENGPAY',
        thread_ts: '1760440200.123',
        message: "Yes, Friday works. The retry PR is approved with CI green, and the dead-letter queue it needs merged yesterday. I'll merge Thursday morning so we get a day on staging first. Failed deliveries retry 5 times over ~2h, then land in the DLQ.",
      },
      status: 'needs_you',
      link: null,
      why: 'name verb',
      allowedBy: null,
      itemId: W.ID.item.priya,
      attemptedAt: t(34 * MIN),
      settledAt: null,
      queue: {
        args: {
          channel_id: 'C04ENGPAY',
          thread_ts: '1760440200.123',
          message: "Yes, Friday works. The retry PR is approved with CI green, and the dead-letter queue it needs merged yesterday. I'll merge Thursday morning so we get a day on staging first. Failed deliveries retry 5 times over ~2h, then land in the DLQ.",
        },
        queuedAt: t(34 * MIN),
        expiresAt: now + 7 * DAY,
        sendAt: null,
        note: null,
        edits: 0,
        delivery: null,
        costUsd: null,
      },
    }),
    rec({
      id: `${W.ID.s.fixN1}:toolu_demo_pr`,
      sessionId: W.ID.s.fixN1,
      sessionKind: 'chat',
      tool: 'Bash',
      kind: 'pr',
      summary: 'Opened acme/api#486: Fix N+1 query in GET /orgs/:id/members',
      args: { command: 'gh pr create --title "Fix N+1 query in GET /orgs/:id/members"' },
      status: 'succeeded',
      link: 'https://github.com/acme/api/pull/486',
      why: 'bash pattern',
      allowedBy: 'prompt',
      itemId: W.ID.item.n1,
      attemptedAt: t(3 * HOUR - 4 * MIN),
      settledAt: t(3 * HOUR - 4 * MIN) + 3_000,
    }),
    rec({
      id: `${W.ID.s.fixN1}:toolu_demo_push`,
      sessionId: W.ID.s.fixN1,
      sessionKind: 'chat',
      tool: 'Bash',
      kind: 'push',
      summary: 'Pushed fix/org-members-n-plus-one to acme/api',
      args: { command: 'git push -u origin fix/org-members-n-plus-one' },
      status: 'succeeded',
      link: 'https://github.com/acme/api/tree/fix/org-members-n-plus-one',
      why: 'bash pattern',
      allowedBy: 'mode',
      itemId: W.ID.item.n1,
      attemptedAt: t(3 * HOUR - 5 * MIN),
      settledAt: t(3 * HOUR - 5 * MIN) + 4_000,
    }),
    rec({
      id: `${W.ID.s.latency}:toolu_demo_linear`,
      sessionId: W.ID.s.latency,
      sessionKind: 'chat',
      tool: 'mcp__claude_ai_Linear__create_issue',
      kind: 'ticket',
      summary: 'Filed ACME-232: Add a pg_trgm index for fuzzy customer search',
      args: { team: 'ACME', title: 'Add a pg_trgm index for fuzzy customer search' },
      status: 'succeeded',
      link: 'https://linear.app/acme/issue/ACME-232',
      why: 'name verb',
      allowedBy: 'prompt',
      itemId: null,
      attemptedAt: t(25 * HOUR),
      settledAt: t(25 * HOUR) + 2_000,
    }),
    rec({
      id: `${W.ID.s.fixN1}:toolu_demo_comment`,
      sessionId: W.ID.s.fixN1,
      sessionKind: 'chat',
      tool: 'mcp__claude_ai_Linear__create_comment',
      kind: 'comment',
      summary: 'Commented on ACME-224: "Fix is up in acme/api#486…"',
      args: { issue: 'ACME-224', body: 'Fix is up in acme/api#486: 401 → 1 queries for a 400-member org.' },
      status: 'succeeded',
      link: 'https://linear.app/acme/issue/ACME-224',
      why: 'name verb',
      allowedBy: 'prompt',
      itemId: W.ID.item.n1,
      attemptedAt: t(3 * HOUR - 3 * MIN),
      settledAt: t(3 * HOUR - 3 * MIN) + 1_500,
    }),
    rec({
      id: `${W.ID.s.flags}:toolu_demo_merge`,
      sessionId: W.ID.s.flags,
      sessionKind: 'chat',
      tool: 'Bash',
      kind: 'merge',
      summary: 'Merge acme/web#1284: blocked, a required check is still pending',
      args: { command: 'gh pr merge 1284 --repo acme/web --squash' },
      status: 'failed',
      link: 'https://github.com/acme/web/pull/1284',
      error: 'Pull request is not mergeable: the "e2e" required check is pending',
      why: 'bash pattern',
      allowedBy: 'prompt',
      itemId: W.ID.item.billingTab,
      attemptedAt: t(55 * MIN),
      settledAt: t(55 * MIN) + 2_000,
    }),
  ]
  for (const r of records) {
    at(r.attemptedAt)
    await store.actions.put(r)
    if (r.status === 'needs_you') {
      await store.actions.addHistory({ actionId: r.id, at: r.attemptedAt, actor: 'agent', event: 'queued', from: null, to: 'needs_you', note: null, args: r.args })
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
if (isMain) {
  const i = process.argv.indexOf('--home')
  const home = i > 0 ? process.argv[i + 1].replace(/^~(?=$|\/)/, os.homedir()) : DEFAULT_HOME
  seed(home)
    .then((r) => console.log(`seeded ${r.home}\n  project: ${r.projectPath}`))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
