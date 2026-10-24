/**
 * Won't fix and Incorrect replies wait for you (plan item `bot-triage-send`,
 * pillar P3). A bot triage (watch.ts, `triage-bot`) hands in a verdict per
 * thread; its fix verdicts become fix tasks on Junior. The rest become ONE
 * task on you, "Send 3 replies", carrying the drafted reply per thread.
 *
 * Nothing on it goes out until you press Send, or until an advance approval
 * you wrote covers that bot (core/approvals, `bot-reply`: who = the bot's
 * login, when = babysit's "bot reply" step). Each reply posts on its thread,
 * resolves it, and is its own record in Junior's log.
 *
 * Your edits win: a changed reply goes out as you wrote it; a verdict you
 * turn into Fix becomes a fix task instead of a reply. Every verdict you
 * approved yourself feeds the tally (bot-triage.ts, rule 3); ones a standing
 * rule sent don't, so the tally never learns from itself.
 *
 * Pure: no I/O, no clock. The send itself is server/tasks/bot-replies.ts.
 */
import { addToTally, BOTS, GENERAL_RULE, type Bot, type Tally, type TallyRow, type Verdict, type VerdictKind, type VerdictRecord, VERDICTS } from './bot-triage.js'
import { botName, fixThreadTask, type TaskSpec, type TriageThread } from './watch.js'

/** The task on you that carries the drafted replies. */
export const SEND_BOT_REPLIES_STEP = 'send-bot-replies'

/** The step an advance approval's `when` names to cover these sends. */
export const BOT_REPLY_STEP = { playbook: 'babysit', step: 'bot reply' } as const

/** Where the tally of your approved verdicts lives in config. */
export const BOT_TALLY_KEY = 'babysit.botTally'

/** A reply is at most this long. GitHub takes more; a reply to a bot never needs it. */
export const MAX_BOT_REPLY = 4000

export type ReplyVerdict = Exclude<VerdictKind, 'fix'>

/** One drafted reply, as the task carries it: enough to show it, send it, or turn it into a fix. */
export type BotReply = {
  threadId: string
  /** the thread's author login, as GitHub gave it */
  author: string
  bot: Bot | null
  rule: string
  path: string | null
  url: string | null
  /** the bot's claim in one line */
  message: string
  /** the bot's comment, clipped: a fix task needs it */
  body: string
  verdict: ReplyVerdict
  reply: string
  why?: string
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

/** "2 won't fix, 1 incorrect" */
function verdictLine(replies: readonly Pick<BotReply, 'verdict'>[]): string {
  const w = replies.filter((r) => r.verdict === 'wont-fix').length
  const i = replies.filter((r) => r.verdict === 'incorrect').length
  return [w ? `${w} won't fix` : '', i ? `${i} incorrect` : ''].filter(Boolean).join(', ')
}

/**
 * A finished triage → the task on you with its non-fix verdicts, or null when
 * every verdict was a fix. Verdicts for threads the triage didn't carry are
 * dropped. Born waiting, owned by you: the runner never takes it.
 */
export function repliesTask(triageTaskId: string, threads: readonly TriageThread[], verdicts: readonly Verdict[]): TaskSpec | null {
  const byId = new Map(threads.map((t) => [t.id, t]))
  const replies: BotReply[] = []
  for (const v of verdicts) {
    if (v.verdict === 'fix') continue
    const t = byId.get(v.threadId)
    if (!t || !v.reply.trim()) continue
    replies.push({
      threadId: t.id,
      author: t.author,
      bot: t.bot ?? null,
      rule: t.rule ?? GENERAL_RULE,
      path: t.path,
      url: t.url,
      message: t.message ?? '',
      body: t.body,
      verdict: v.verdict,
      reply: v.reply.trim().slice(0, MAX_BOT_REPLY),
      ...(v.why ? { why: v.why } : {}),
    })
  }
  if (!replies.length) return null
  const bots = [...new Set(replies.map((r) => r.bot ?? botName(r.author)))]
  return {
    title: bots.length === 1 ? `Send ${n(replies.length, 'reply', 'replies')} to ${bots[0]}` : `Send ${n(replies.length, 'bot reply', 'bot replies')}`,
    owner: 'you',
    state: 'waiting',
    why: 'junior',
    whyDetail: verdictLine(replies),
    step: SEND_BOT_REPLIES_STEP,
    key: `bot-replies:${triageTaskId}`,
    input: { triageTaskId, replies },
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : null)

/** A replies task's drafted replies, read back from its input. Anything malformed is dropped. */
export function botRepliesOf(input: Record<string, unknown> | undefined): BotReply[] {
  const raw = Array.isArray(input?.replies) ? (input.replies as unknown[]) : []
  const out: BotReply[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const threadId = str(o.threadId)?.trim()
    const reply = str(o.reply)?.trim()
    if (!threadId || !reply || (o.verdict !== 'wont-fix' && o.verdict !== 'incorrect')) continue
    out.push({
      threadId,
      author: str(o.author) ?? '',
      bot: BOTS.includes(o.bot as Bot) ? (o.bot as Bot) : null,
      rule: str(o.rule) ?? GENERAL_RULE,
      path: str(o.path),
      url: str(o.url),
      message: str(o.message) ?? '',
      body: str(o.body) ?? '',
      verdict: o.verdict,
      reply,
      ...(str(o.why) ? { why: o.why as string } : {}),
    })
  }
  return out
}

/** What you changed on the card for one thread. */
export type ReplyEdit = { verdict?: VerdictKind; reply?: string }

/**
 * The card's edits → per thread. `{ threads: [{ threadId, verdict?, reply? }] }`;
 * an unknown verdict is ignored (Junior's stands), never read as a fix.
 */
export function replyEditsFrom(raw: unknown): Map<string, ReplyEdit> {
  const out = new Map<string, ReplyEdit>()
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { threads?: unknown }).threads) ? ((raw as { threads: unknown[] }).threads) : []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const id = str(o.threadId)?.trim()
    if (!id || out.has(id)) continue
    const verdict = VERDICTS.includes(o.verdict as VerdictKind) ? (o.verdict as VerdictKind) : undefined
    const reply = str(o.reply)
    out.set(id, { ...(verdict ? { verdict } : {}), ...(reply !== null ? { reply } : {}) })
  }
  return out
}

/**
 * Who says yes. You (the card's Send): everything left goes, as you edited it.
 * A rule: only the replies `covers` names an approval for, as Junior drafted
 * them; the rest keep waiting for you.
 */
export type Approver = { by: 'you' } | { by: 'rule'; covers: (r: BotReply) => string | null }

export type PlannedSend = {
  reply: BotReply
  /** the text that goes out */
  body: string
  verdict: ReplyVerdict
  allowedBy: 'you' | 'rule'
  /** the approval that covered it, under a rule */
  approvalId?: string
}

export type ReplyPlan = {
  sends: PlannedSend[]
  /** threads you turned into Fix: a fix task each, no reply */
  fixes: BotReply[]
  /** still waiting for you (a rule covered only some) */
  waiting: BotReply[]
}

/**
 * The replies not yet handled (sent, or turned into a fix) → what goes out now. Throws on an empty or
 * too-long reply you wrote, before anything is claimed or sent.
 */
export function replyPlan(replies: readonly BotReply[], handled: readonly string[], approver: Approver, edits: ReadonlyMap<string, ReplyEdit> = new Map()): ReplyPlan {
  const plan: ReplyPlan = { sends: [], fixes: [], waiting: [] }
  const done = new Set(handled)
  for (const r of replies) {
    if (done.has(r.threadId)) continue
    if (approver.by === 'rule') {
      const approvalId = approver.covers(r)
      if (approvalId) plan.sends.push({ reply: r, body: r.reply, verdict: r.verdict, allowedBy: 'rule', approvalId })
      else plan.waiting.push(r)
      continue
    }
    const e = edits.get(r.threadId)
    const verdict = e?.verdict ?? r.verdict
    if (verdict === 'fix') {
      plan.fixes.push(r)
      continue
    }
    const body = (e?.reply ?? r.reply).trim()
    if (!body) throw new Error(`the reply on ${where(r)} is empty`)
    if (body.length > MAX_BOT_REPLY) throw new Error(`a reply is at most ${MAX_BOT_REPLY} characters`)
    plan.sends.push({ reply: r, body, verdict, allowedBy: 'you' })
  }
  return plan
}

/** "api.ts", or the bot's name when the thread has no file. */
const where = (r: Pick<BotReply, 'path' | 'author' | 'bot'>) => (r.path ? r.path.split('/').pop()! : `${r.bot ?? botName(r.author)}'s comment`)

/** A thread you turned into Fix → "Fix CodeRabbit comment on api.ts" on Junior. */
export function replyFixTask(r: BotReply): TaskSpec {
  return fixThreadTask({ id: r.threadId, author: r.author, isBot: true, resolved: false, path: r.path, body: r.body, url: r.url }, `the user changed Junior's ${r.verdict === 'wont-fix' ? "won't fix" : 'incorrect'} to fix`)
}

const REPLY_MUTATION = 'mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}'
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'

/** gh args that post the reply on the thread. Its answer carries the comment's url. */
export const replyArgs = (threadId: string, body: string): string[] => ['api', 'graphql', '-f', `query=${REPLY_MUTATION}`, '-f', `id=${threadId}`, '-f', `body=${body}`]

/** gh args that resolve the thread after the reply. */
export const resolveArgs = (threadId: string): string[] => ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${threadId}`]

/** The reply's url out of the mutation's answer, or null. */
export function replyUrlOf(out: string): string | null {
  try {
    const url = (JSON.parse(out) as { data?: { addPullRequestReviewThreadReply?: { comment?: { url?: unknown } } } }).data?.addPullRequestReviewThreadReply?.comment?.url
    return typeof url === 'string' ? url : null
  } catch {
    return null
  }
}

/** The send as one shell line, for the log record: word for word what went out. */
export function sendCommandLine(threadId: string, body: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return [['gh', ...replyArgs(threadId, body)], ['gh', ...resolveArgs(threadId)]].map((c) => c.map((a, i) => (i > 0 && /[^\w@%+=:,./-]/.test(a) ? q(a) : a)).join(' ')).join(' && ')
}

/** The log record's line: "Reply to CodeRabbit on api.ts (won't fix): Keeping the any here…" */
export function sendRecordSummary(s: Pick<PlannedSend, 'reply' | 'body' | 'verdict'>, pr: { repo: string; number: number }): string {
  const first = s.body.split('\n')[0]!.trim()
  const clipped = first.length > 100 ? `${first.slice(0, 99)}…` : first
  const file = s.reply.path ? ` on ${s.reply.path.split('/').pop()}` : ''
  return `Reply to ${s.reply.bot ?? botName(s.reply.author)}${file} (${s.verdict === 'wont-fix' ? "won't fix" : 'incorrect'}) on ${pr.repo}#${pr.number}: ${clipped}`
}

/**
 * The verdicts that stood, for the tally. Sent replies carry who allowed them;
 * a thread you turned into Fix is yours, with Junior's pick as `proposed`.
 * A thread from a bot Junior doesn't know by name has no row.
 */
export function verdictRecords(repo: string, sent: readonly PlannedSend[], fixes: readonly BotReply[]): VerdictRecord[] {
  const out: VerdictRecord[] = []
  for (const s of sent) {
    if (!s.reply.bot) continue
    out.push({ repo, finding: { bot: s.reply.bot, rule: s.reply.rule }, verdict: s.verdict, ...(s.verdict !== s.reply.verdict ? { proposed: s.reply.verdict } : {}), approvedBy: s.allowedBy })
  }
  for (const r of fixes) {
    if (!r.bot) continue
    out.push({ repo, finding: { bot: r.bot, rule: r.rule }, verdict: 'fix', proposed: r.verdict, approvedBy: 'you' })
  }
  return out
}

/** The tally as config holds it; anything malformed reads as empty rows dropped. */
export function tallyFrom(raw: unknown): Tally {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Tally = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Partial<TallyRow>
    const nums = [r.fix, r['wont-fix'], r.incorrect, r.total, r.changed]
    if (typeof r.repo !== 'string' || !BOTS.includes(r.bot as Bot) || typeof r.rule !== 'string' || nums.some((x) => typeof x !== 'number' || !Number.isFinite(x))) continue
    out[k] = r as TallyRow
  }
  return out
}

/** The tally with these records added: only the ones you approved count. */
export const tallyWith = (tally: Tally, records: readonly VerdictRecord[]): Tally => records.reduce(addToTally, tally)

/** The task's line once sent: "Sent 3 replies", "Sent 2 replies, 1 to fix", "Sent 1 of 3: 2 failed". */
export function sentLine(sent: number, fixes: number, failed: number, waiting: number): string {
  const head = failed || waiting ? `Sent ${sent} of ${sent + failed + waiting}` : `Sent ${n(sent, 'reply', 'replies')}`
  const tail = [fixes ? `${fixes} to fix` : '', failed ? `${failed} failed` : '', waiting ? `${waiting} wait for you` : ''].filter(Boolean)
  if (!sent && fixes && !failed && !waiting) return `${n(fixes, 'thread')} to fix, no replies`
  return tail.length ? `${head}${failed || waiting ? ': ' : ', '}${tail.join(', ')}` : head
}
