/**
 * The card that approves a bot triage's replies (plan item `bot-triage-card`).
 * The card is web/src/components/item/BotTriageCard.tsx; this is its pure half,
 * so the words and the send body are tested without React.
 *
 * One row per thread: file:line, the bot's claim in one line, a verdict
 * pre-selected to Junior's, the drafted reply. One button sends what's left.
 * A verdict flipped to Fix becomes a fix task for Junior instead of a reply.
 *
 * Browser-safe: no I/O, no clock.
 */
import { BOTS, GENERAL_RULE, type Bot, type VerdictKind } from './bot-triage.js'

/** The task on you that carries the drafted replies. */
export const SEND_BOT_REPLIES_STEP = 'send-bot-replies'

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
  /** the line the thread sits on, when GitHub gave it */
  line?: number
  url: string | null
  /** the bot's claim in one line */
  message: string
  /** the bot's comment, clipped: a fix task needs it */
  body: string
  verdict: ReplyVerdict
  reply: string
  why?: string
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
      ...(typeof o.line === 'number' && Number.isInteger(o.line) && o.line > 0 ? { line: o.line } : {}),
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

/** What the user has on one row now: their verdict and their text. */
export type RowPick = { verdict: VerdictKind; reply: string }

export const VERDICT_LABEL: Record<VerdictKind, string> = { fix: 'Fix', 'wont-fix': 'Won’t fix', incorrect: 'Incorrect' }

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`

/** A bot's comment as one readable paragraph: no HTML, badges, folded details or links to "fix in". */
export function plainClaim(body: string, max = 360): string {
  const s = body
    .replace(/^#{1,6}\s*(.+?)\s*$/gm, '$1.')
    .replace(/^\*\*(.+?)\*\*\s*$/gm, '$1.')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<details>[\s\S]*?<\/details>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

/** "Bugbot" for cursor[bot], else the login without [bot] (watch.ts botName, kept browser-light). */
const nameOf = (r: Pick<BotReply, 'bot' | 'author'>) => r.bot ?? (r.author.replace(/\[bot\]$/, '') === 'cursor' ? 'Bugbot' : r.author.replace(/\[bot\]$/, ''))

/** "api.ts:42", "api.ts", or the bot's name when the thread has no file. */
export function fileLine(r: Pick<BotReply, 'path' | 'line' | 'bot' | 'author'>): string {
  if (!r.path) return nameOf(r)
  const file = r.path.split('/').pop()!
  return r.line ? `${file}:${r.line}` : file
}

/** The file for the verdict group's label: "Verdict on api.ts". */
export const fileOf = (r: Pick<BotReply, 'path' | 'bot' | 'author'>): string => (r.path ? r.path.split('/').pop()! : `${nameOf(r)}’s comment`)

/** The bot's claim in one line: the triage's message, else the comment made plain. */
export const claimOf = (r: Pick<BotReply, 'message' | 'body'>): string => r.message.trim() || plainClaim(r.body, 200)

/** The closed reply's preview: its first non-empty line. */
export function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim()
}

/** The picks the card starts from: Junior's verdict and Junior's draft on every row. */
export const startPicks = (replies: readonly BotReply[]): Record<string, RowPick> =>
  Object.fromEntries(replies.map((r) => [r.threadId, { verdict: r.verdict, reply: r.reply }]))

/** True once the user's text differs from Junior's draft. */
export const edited = (r: BotReply, p: RowPick): boolean => p.reply.trim() !== r.reply.trim()

/** The rows still to send (not sent, not turned into a fix on an earlier press). */
export const rowsLeft = (replies: readonly BotReply[], handled: readonly string[]): BotReply[] => replies.filter((r) => !handled.includes(r.threadId))

/** Rows left that can't go: a reply verdict with no text. */
export function emptyRows(left: readonly BotReply[], picks: Readonly<Record<string, RowPick>>): string[] {
  return left.filter((r) => {
    const p = picks[r.threadId]
    return p && p.verdict !== 'fix' && !p.reply.trim()
  }).map((r) => r.threadId)
}

/** How many of the rows left go as replies and how many become fix tasks. */
export function tally(left: readonly BotReply[], picks: Readonly<Record<string, RowPick>>): { replies: number; fixes: number } {
  let fixes = 0
  for (const r of left) if ((picks[r.threadId]?.verdict ?? r.verdict) === 'fix') fixes++
  return { replies: left.length - fixes, fixes }
}

/** "Send 3 replies", "Send 1 reply", "Send 2 replies · 1 to fix", "Hand 2 to Junior to fix". */
export function sendLabel(t: { replies: number; fixes: number }): string {
  if (!t.replies && t.fixes) return `Hand ${t.fixes} to Junior to fix`
  const head = `Send ${n(t.replies, 'reply', 'replies')}`
  return t.fixes ? `${head} · ${t.fixes} to fix` : head
}

/**
 * The body for POST /api/tasks/send-bot-replies: only what changed per thread.
 * A verdict goes when it differs from Junior's; a reply goes when its text
 * differs and the row isn't Fix. Rows already handled are left out.
 */
export function sendBody(taskId: string, left: readonly BotReply[], picks: Readonly<Record<string, RowPick>>): { id: string; threads: { threadId: string; verdict?: VerdictKind; reply?: string }[] } {
  const threads: { threadId: string; verdict?: VerdictKind; reply?: string }[] = []
  for (const r of left) {
    const p = picks[r.threadId]
    if (!p) continue
    const verdict = p.verdict !== r.verdict ? p.verdict : undefined
    const reply = p.verdict !== 'fix' && edited(r, p) ? p.reply.trim() : undefined
    if (verdict === undefined && reply === undefined) continue
    threads.push({ threadId: r.threadId, ...(verdict ? { verdict } : {}), ...(reply !== undefined ? { reply } : {}) })
  }
  return { id: taskId, threads }
}

/** "1 reply didn't go out: {error}. Send again to retry." for a task back to waiting after a failed send. */
export function retryLine(left: number, error: string): string {
  return `${n(left, 'reply', 'replies')} didn’t go out: ${error.replace(/\.\s*$/, '')}. Send again to retry.`
}
