/**
 * Bot-comment triage (plan item `bot-triage-core`, pillar P3). Today every
 * bot review thread becomes a fix task, and most are nits. This is the pure
 * half of sorting them first:
 *
 *   Finding   one bot comment, in reviewdog rdjson's shape (path, line, bot,
 *             rule, message), so any bot reads the same
 *   Verdict   fix: Junior fixes it · wont-fix / incorrect: a reply goes back
 *             to the bot instead, drafted here, sent only once the user OKs it
 *   Tally     the user's approved verdicts, counted per repo × bot × rule, so
 *             Junior can later say "you've marked 9 of 10 of these won't fix"
 *   botOf     which of the five review bots wrote a comment, by login
 *
 * Rules:
 *   1. Anything Junior can't read as a clear non-fix verdict is a fix. A
 *      wrong "fix" costs a task; a wrong "won't fix" drops a real bug.
 *   2. A reply verdict needs reply text. Without one it is a fix.
 *   3. The tally counts only verdicts the user approved themselves. Junior's
 *      own proposals, and sends a standing rule approved, are left out, so
 *      the tally never learns from itself.
 *
 * Pure: no I/O, no clock. Browser-safe. Wiring (one triage task per PR, the
 * reply send path, the card) is bot-triage-task, -send and -card.
 */
import type { PrThread } from './ci.js'

/** The five review bots Junior knows by name. */
export type Bot = 'CodeRabbit' | 'Copilot' | 'Greptile' | 'Bugbot' | 'Qodo'

export const BOTS: readonly Bot[] = ['CodeRabbit', 'Copilot', 'Greptile', 'Bugbot', 'Qodo']

/**
 * Logins per bot, lowercased and without the `[bot]` suffix (GraphQL drops it
 * on a Bot author; REST keeps it). Older names stay so old threads still sort.
 */
const LOGINS: Record<Bot, readonly string[]> = {
  CodeRabbit: ['coderabbitai', 'coderabbit', 'coderabbit-ai'],
  Copilot: ['copilot', 'copilot-pull-request-reviewer', 'github-copilot', 'copilot-swe-agent'],
  Greptile: ['greptile-apps', 'greptile', 'greptileai', 'greptile-apps-staging'],
  Bugbot: ['cursor', 'cursor-bugbot', 'bugbot'],
  Qodo: ['qodo-merge', 'qodo-merge-pro', 'qodo-ai', 'qodo-code-review', 'qodo-merge-pro-for-open-source', 'codiumai-pr-agent', 'codiumai-pr-agent-pro', 'codium-pr-agent'],
}

const BY_LOGIN = new Map<string, Bot>(BOTS.flatMap((bot) => LOGINS[bot].map((login) => [login, bot] as const)))

/** `coderabbitai[bot]`, `CodeRabbitAI`, ` cursor ` → the bare lowercase login. */
const bare = (login: string) => login.trim().toLowerCase().replace(/\[bot\]$/, '')

/** Which of the five bots wrote this, by login; null for anyone else (people, dependabot, CI bots). */
export function botOf(author: string | null | undefined): Bot | null {
  if (!author) return null
  return BY_LOGIN.get(bare(author)) ?? null
}

/** One bot comment, rdjson-shaped. `rule` is the bot's own category, or `general`. */
export type Finding = {
  /** the review thread it came from, so a verdict maps back to one thread */
  threadId: string
  path: string | null
  line: number | null
  bot: Bot
  rule: string
  /** the comment's claim, first meaningful line, clipped */
  message: string
  url: string | null
}

/** The rule a finding falls under when the bot names none. */
export const GENERAL_RULE = 'general'

const MAX_MESSAGE = 200
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/**
 * The labels the bots put on a comment, lowercased to a rule slug. CodeRabbit
 * opens with `_⚠️ Potential issue_` / `_🛠️ Refactor suggestion_` / `_🧹 Nitpick_`;
 * Bugbot with `### Bug: …`. Word edges are letters only, since `_Nitpick_` is
 * markdown italics. Anything else is general.
 */
const RULE_LABELS: readonly { rule: string; test: RegExp }[] = [
  { rule: 'potential-issue', test: /potential issue/i },
  { rule: 'refactor-suggestion', test: /refactor suggestion/i },
  { rule: 'nitpick', test: /(?<![a-z])nit(pick)?s?(?![a-z])/i },
  { rule: 'security', test: /(?<![a-z])security(?![a-z])/i },
  { rule: 'performance', test: /(?<![a-z])performance(?![a-z])/i },
  { rule: 'bug', test: /^\s*#{0,4}\s*\**bug(?![a-z])/im },
  { rule: 'style', test: /(?<![a-z])(style|formatting|naming)(?![a-z])/i },
]

/** The rule a bot comment falls under, read off its opening label; `general` when there isn't one. */
export function ruleOf(body: string): string {
  // only the opening lines carry the label; the rest is the bot's argument
  const head = body.split('\n').slice(0, 3).join('\n')
  for (const { rule, test } of RULE_LABELS) if (test.test(head)) return rule
  return GENERAL_RULE
}

/** The comment's claim in one line: the first line that isn't a label, a heading mark, markup or blank. */
export function messageOf(body: string): string {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .split('\n')
    .map((l) => l.replace(/^[#>\s*_-]+|[*_]+$/g, '').trim())
    .filter(Boolean)
  const claim = lines.find((l) => !/^(\p{Extended_Pictographic}|️|\s)*(potential issue|refactor suggestion|nitpick( comments?)?|bug)\s*:?$/iu.test(l)) ?? lines[0] ?? ''
  return clip(claim.replace(/\s+/g, ' '), MAX_MESSAGE)
}

/**
 * A review thread → a finding, when one of the five bots wrote it and it is
 * still open. `line` comes from the caller (the snapshot doesn't carry it yet).
 */
export function findingOf(thread: PrThread, line: number | null = null): Finding | null {
  if (thread.resolved) return null
  const bot = botOf(thread.author)
  if (!bot) return null
  return { threadId: thread.id, path: thread.path, line, bot, rule: ruleOf(thread.body), message: messageOf(thread.body), url: thread.url }
}

export type VerdictKind = 'fix' | 'wont-fix' | 'incorrect'

export const VERDICTS: readonly VerdictKind[] = ['fix', 'wont-fix', 'incorrect']

/** What to do with one finding. A non-fix verdict carries the reply to post on the thread. */
export type Verdict =
  | { threadId: string; verdict: 'fix'; why?: string }
  | { threadId: string; verdict: 'wont-fix' | 'incorrect'; reply: string; why?: string }

const MAX_REPLY = 2000

/**
 * Whatever Junior handed in for one thread → a verdict. Unsure, unknown or
 * malformed is a fix (rule 1); a reply verdict without reply text is a fix
 * (rule 2). Null only when it names no thread at all.
 */
export function verdictFrom(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const threadId = typeof r.threadId === 'string' ? r.threadId.trim() : ''
  if (!threadId) return null
  const why = typeof r.why === 'string' && r.why.trim() ? clip(r.why.trim(), MAX_MESSAGE) : undefined
  const kind = typeof r.verdict === 'string' ? r.verdict.trim().toLowerCase().replace(/[\s_]+/g, '-') : ''
  const reply = typeof r.reply === 'string' ? r.reply.trim() : ''
  if ((kind === 'wont-fix' || kind === 'incorrect') && reply) {
    return { threadId, verdict: kind, reply: clip(reply, MAX_REPLY), ...(why ? { why } : {}) }
  }
  return { threadId, verdict: 'fix', ...(why ? { why } : {}) }
}

/**
 * One verdict per finding, in the findings' order. A finding Junior gave no
 * verdict for (or gave a malformed one) is a fix; verdicts for threads that
 * aren't findings are dropped; the first verdict for a thread wins.
 */
export function verdictsFor(findings: readonly Pick<Finding, 'threadId'>[], raw: readonly unknown[]): Verdict[] {
  const given = new Map<string, Verdict>()
  for (const r of raw) {
    const v = verdictFrom(r)
    if (v && !given.has(v.threadId)) given.set(v.threadId, v)
  }
  return findings.map((f) => given.get(f.threadId) ?? { threadId: f.threadId, verdict: 'fix' })
}

/** Who said yes to a verdict: the user, a standing rule they wrote, or nobody yet. */
export type ApprovedBy = 'you' | 'rule' | null

/** One verdict as it was decided: the finding, the verdict that stood, who approved it. */
export type VerdictRecord = {
  repo: string
  finding: Pick<Finding, 'bot' | 'rule'>
  /** the verdict that stood, after any change the user made */
  verdict: VerdictKind
  /** Junior's own pick, when it differs from what stood; counts as "changed" */
  proposed?: VerdictKind
  approvedBy: ApprovedBy
}

export type TallyRow = {
  repo: string
  bot: Bot
  rule: string
  fix: number
  'wont-fix': number
  incorrect: number
  total: number
  /** how many times the user picked something other than Junior's verdict */
  changed: number
}

/** Rows keyed by tallyKey(repo, bot, rule). Plain JSON, so it can sit in config as is. */
export type Tally = Record<string, TallyRow>

/** `acme/api · CodeRabbit · nitpick`, case-folded on repo and rule. */
export function tallyKey(repo: string, bot: Bot, rule: string): string {
  return `${repo.trim().toLowerCase()}\u0000${bot}\u0000${(rule.trim() || GENERAL_RULE).toLowerCase()}`
}

/** Whether a record counts toward the tally: the user approved it themselves (rule 3). */
export function counts(record: VerdictRecord): boolean {
  return record.approvedBy === 'you' && VERDICTS.includes(record.verdict) && BOTS.includes(record.finding.bot)
}

/** The tally with one record added. Returns the same tally when the record doesn't count. Never mutates. */
export function addToTally(tally: Tally, record: VerdictRecord): Tally {
  if (!counts(record)) return tally
  const { bot } = record.finding
  const rule = (record.finding.rule.trim() || GENERAL_RULE).toLowerCase()
  const repo = record.repo.trim().toLowerCase()
  const key = tallyKey(repo, bot, rule)
  const was: TallyRow = tally[key] ?? { repo, bot, rule, fix: 0, 'wont-fix': 0, incorrect: 0, total: 0, changed: 0 }
  const changed = record.proposed !== undefined && record.proposed !== record.verdict ? 1 : 0
  return { ...tally, [key]: { ...was, [record.verdict]: was[record.verdict] + 1, total: was.total + 1, changed: was.changed + changed } }
}

/** A tally from scratch, over every record. */
export function tallyOf(records: readonly VerdictRecord[]): Tally {
  return records.reduce(addToTally, {} as Tally)
}

/** One row of the tally; null when the user has approved nothing under it yet. */
export function tallyFor(tally: Tally, repo: string, bot: Bot, rule: string): TallyRow | null {
  return tally[tallyKey(repo, bot, rule)] ?? null
}
