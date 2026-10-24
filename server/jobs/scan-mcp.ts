import { z } from 'zod'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { WorkItem as CoreWorkItem, Provenance, WorkSource } from '../../core/work/types.js'
import { permalinkId, safeWhen } from '../../core/sources/slack.js'
import { canonicalizeRef, canonicalizeRefs } from '../../core/work/link.js'
import { sourceOf } from '../../shared/sources.js'
import { type Ask, ASK_ORDER } from '../../core/work/asks.js'
import type { Job } from '../../core/job/types.js'
import type { UpsertOutcome } from '../../core/store/types.js'
import { MAX_ROWS_PER_RUN } from '../../core/job/connectors.js'
import { parseDue } from '../../core/work/due.js'
import { log } from '../log.js'
import { slug } from '../artifacts.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { VERSION } from '../config.js'
import { errResult, okResult } from '../junior-mcp.js'
import { upsertItem } from '../settings-ops.js'
import { invalidateInbox } from '../ws/send.js'
import { briefFiledItem } from '../brief-run.js'
import { DEFAULT_FILING, filedSource, labelsOf, type JobFiling } from '../../core/job/filing.js'
import { isItemLabel, isReason, type ItemLabel, type Reason } from '../../core/work/fields.js'
import { isTier, type Tier } from '../../core/rules/rules.js'
import { applyRules } from '../rules-ops.js'
import { promiseThreadOf } from '../../core/work/promise-items.js'
import { filePromisesOp } from '../inbox/promises.js'

/**
 * Identity for a filed item, derived from the link the scanner saw, never from
 * the job. A Slack permalink → slack:<tail>; a GitHub PR/issue URL →
 * github:owner/repo#n; a Linear URL or key → linear:KEY-n. Anything else is
 * rejected: an id we cannot canonicalize cannot dedupe.
 */
export function identityFromUrl(raw: string): { id: string; source: WorkSource; url: string; home: string } | null {
  const url = raw.trim()
  if (/\/archives\//.test(url)) return { id: permalinkId(url), source: 'slack', url, home: '' }
  const ref = canonicalizeRef(url)
  if (!ref) return null
  if (ref.startsWith('github:')) {
    const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref)
    if (!m) return null
    const href = url.startsWith('http') ? url : (sourceOf('github').link(ref) ?? url)
    return { id: ref, source: 'github', url: href, home: m[1] }
  }
  if (ref.startsWith('linear:')) {
    const key = ref.slice('linear:'.length)
    const href = url.startsWith('http') ? url : (sourceOf('linear').link(ref) ?? url)
    return { id: ref, source: 'linear', url: href, home: key.slice(0, key.indexOf('-')) }
  }
  if (ref.startsWith('web:')) return { id: ref, source: 'web', url, home: webHost(url) }
  return null
}

function webHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The upsert tool's arguments: shared by the real run and the dry run so the prompt fits both. */
const UPSERT_SHAPE = {
  url: z.string().describe('the canonical link: Slack permalink, Linear issue URL or key, GitHub PR/issue URL, or the web page URL'),
  title: z.string().describe('a one-line summary'),
  place: z.string().optional().describe('where it lives: "#channel", "@dm", a Linear team key, "owner/repo", or the site name'),
  from: z.string().optional().describe('the author or asker'),
  lastActivity: z.string().describe('ISO 8601 timestamp of the newest activity'),
  why: z.string().describe('one line: exactly what matched the instructions'),
  ask: z.enum(ASK_ORDER as [Ask, ...Ask[]]).describe('what it asks of the user: review, reply, decide, do, follow-up or read'),
  due: z.string().optional().describe('only when the content states a deadline for the user: the day, ISO 8601 (e.g. 2026-10-12)'),
  refs: z.array(z.string()).optional().describe('other GitHub PR/issue URLs or Linear keys in the content'),
  yours: z
    .array(
      z.object({
        text: z.string().describe('the message, verbatim'),
        at: z.string().describe('ISO 8601 timestamp it was sent'),
        replyTo: z.string().optional().describe('who the message replies to, when it is a reply'),
      }),
    )
    .max(10)
    .optional()
    .describe("the user's own messages in this thread, verbatim, newest last: only ones the user wrote. Omit when the user wrote none"),
}
/**
 * The upsert tool's arguments for one job: the base shape, plus the label
 * (from the labels it may pick), the reason when it may pick one, and the
 * tier when it has tiers (core/job/filing.ts).
 */
export function upsertShape(filing: JobFiling | undefined) {
  const f = filing ?? DEFAULT_FILING
  const labels = labelsOf(f) as [ItemLabel, ...ItemLabel[]]
  return {
    ...UPSERT_SHAPE,
    label: z.enum(labels).optional().describe('what it is'),
    ...(f.reasons.length > 1 ? { reason: z.enum(f.reasons as [Reason, ...Reason[]]).optional().describe('why it is here') } : {}),
    ...(f.tiers ? { tier: z.enum(['start', 'show']).optional().describe('"start": Junior may start on it alone; "show": only for the user to see') } : {}),
  }
}

/** A row's reason, label and tier, checked against what the job allows; anything else reads as the default. */
export function rowFiling(filing: JobFiling | undefined, args: { reason?: unknown; label?: unknown; tier?: unknown }): { reason: Reason; label?: ItemLabel; tier: Tier } {
  const f = filing ?? DEFAULT_FILING
  const reason = isReason(args.reason) && f.reasons.includes(args.reason) ? args.reason : f.reasons[0]!
  const label = isItemLabel(args.label) && labelsOf(f).includes(args.label) ? args.label : undefined
  // a job with tiers files "show" unless the run said "start"; one without leaves it to the rules
  const tier: Tier = f.tiers ? (isTier(args.tier) ? args.tier : 'show') : 'start'
  return { reason, ...(label ? { label } : {}), tier }
}

export const DIGEST_SHAPE = {
  title: z.string().describe('a short name for this edition, e.g. "AI news · 12 Sep"'),
  body: z.string().describe('the whole digest as markdown'),
  refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys cited in the digest'),
}

/**
 * The per-run ingestion tool. Upsert-only, link-shaped: the scanner passes
 * what it can see (a link, title, why, timestamp, refs); the server derives
 * identity from the link and stamps kind and provenance (this job + run). So
 * the model only ADDS candidates and annotates why, lifecycle stays in code.
 */
export function makeScanMcp(rt: WorkspaceRuntime, job: Job, runId: string, onUpsert: (outcome: UpsertOutcome) => void) {
  let count = 0
  if (job.output === 'digest') return makeDigestMcp(rt, job, runId, onUpsert)
  return createSdkMcpServer({
    name: 'junior',
    version: VERSION,
    tools: [
      tool(
        'upsert_work_item',
        'Record ONE match as a work item. Call once per match; the server derives the id from the link and stamps provenance.',
        upsertShape(job.filing),
        async (args) => {
          try {
            // Cost guard, enforced here not just in the prompt.
            if (count >= MAX_ROWS_PER_RUN) {
              return errResult(`row cap reached (${MAX_ROWS_PER_RUN}) — stop calling this tool`)
            }
            const ident = identityFromUrl(args.url)
            if (!ident) return errResult('url must be a Slack permalink, a Linear issue URL or key, or a GitHub PR/issue URL')
            count += 1
            const now = Date.now()
            const when = safeWhen(args.lastActivity, now)
            const refs = canonicalizeRefs(args.refs)
            const filed = rowFiling(job.filing, args)
            const item: CoreWorkItem = {
              id: ident.id,
              // a Sentry job's links read as Sentry, not the web (filing.ts filedSource)
              source: filedSource(job.filing, ident.source),
              kind: job.createsItems ? 'job-hit' : 'fyi',
              title: args.title,
              url: ident.url,
              repo: args.place?.trim() || ident.home,
              author: args.from ?? '',
              // someone asked: a person waits on you
              peopleWaiting: filed.reason === 'asked' ? 1 : 0,
              createdAt: when,
              updatedAt: when,
              ask: args.ask,
              reason: filed.reason,
              ...(filed.label ? { label: filed.label } : {}),
              ...(parseDue(args.due) != null ? { dueAt: parseDue(args.due)! } : {}),
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { jobId: job.id, runId, at: now, why: args.why }
            const { outcome, reopened } = await upsertItem(rt, item, prov)
            onUpsert(outcome)
            invalidateInbox(rt)
            // The job briefs what it files: the item arrives ready, your turn.
            if (job.brief && (outcome === 'inserted' || reopened)) briefFiledItem(rt, job, item.id, runId)
            // The rules decide what Junior does with it (core/rules).
            if (outcome === 'inserted' || reopened) void applyRules(rt, item.id, filed.tier)
            // Your own words in the thread: what you said you would do becomes a promise item.
            if (args.yours?.length) {
              await filePromisesOp(rt, promiseThreadOf(item, args.yours, now, job.id), { jobId: job.id, runId, at: now }).catch((err: unknown) =>
                log('warn', 'job', `could not file promises from ${item.id}: ${err instanceof Error ? err.message : String(err)}`, { jobId: job.id, runId, workspace: rt.meta.id }),
              )
            }
            log('info', 'job', `filed (${outcome}): ${item.title}`, {
              id: item.id,
              jobId: job.id,
              runId,
              place: item.repo,
              outcome,
              workspace: rt.meta.id,
            })
            // Stateless runs need to hear about repeats.
            if (outcome === 'inserted') return okResult(`new: filed ${item.id}`)
            if (reopened) return okResult(`already filed; it was done and has returned to the inbox: ${item.id}`)
            const status = (await rt.store.items.get(item.id))?.status ?? 'open'
            return okResult(
              status === 'open'
                ? `already filed and open: ${item.id}. Do not count it as new; move on to the next candidate.`
                : `already filed, ${status}: ${item.id}`,
            )
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}

/** The one file a digest job rewrites: stable per job, so writeAt updates in place. */
const digestRelPath = (job: Job): string => `reports/${slug(job.title) || 'digest'}-${job.id.slice(0, 8)}.md`

/**
 * The digest job's write tool. One call per run: the server rewrites the
 * job's report artifact in place, upserts the job's single rolling item
 * (id `job:<id>`) with a fresh timestamp, so a done item returns with the
 * "returned" marker, and links report → item. The model writes prose; code
 * owns identity, lifecycle and the link, as everywhere else.
 */
function makeDigestMcp(rt: WorkspaceRuntime, job: Job, runId: string, onWrite: (outcome: UpsertOutcome) => void) {
  let written = false
  return createSdkMcpServer({
    name: 'junior',
    version: VERSION,
    tools: [
      tool(
        'write_digest',
        'Save this run’s digest: ONE markdown report. Call exactly once with the whole document.',
        DIGEST_SHAPE,
        async (args) => {
          try {
            if (written) return errResult('the digest was already written this run — stop calling this tool')
            const title = args.title.trim() || `${job.title} · ${new Date().toLocaleDateString()}`
            const refs = canonicalizeRefs(args.refs)
            const artifact = await rt.artifacts.writeAt(digestRelPath(job), {
              title,
              body: args.body,
              author: 'model',
              ...(refs ? { refs } : {}),
            })
            const nowIso = new Date().toISOString()
            const item: CoreWorkItem = {
              id: `job:${job.id}`,
              source: 'job',
              kind: 'digest',
              title,
              url: `#/artifact/${artifact.id}`,
              repo: job.title,
              author: '',
              peopleWaiting: 0,
              createdAt: nowIso,
              updatedAt: nowIso,
              ...(refs ? { refs } : {}),
            }
            const prov: Provenance = { jobId: job.id, runId, at: Date.now(), why: 'digest rewritten' }
            const { outcome, reopened } = await upsertItem(rt, item, prov)
            await rt.store.links.add({ fromKind: 'artifact', fromId: artifact.id, toKind: 'item', toId: item.id, role: 'report' })
            written = true
            onWrite(outcome)
            invalidateInbox(rt)
            log('info', 'job', `digest written (${outcome}${reopened ? ', returned' : ''}): ${title}`, { id: item.id, jobId: job.id, runId, artifact: artifact.path, workspace: rt.meta.id })
            return okResult(`ok: digest saved as ${artifact.path}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
    ],
  })
}
