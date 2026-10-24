/**
 * Message status: does a message ask anything of you? Three answers, each
 * with the reason it got it. Pure, browser-safe, no time, no model call.
 *
 *   approval   someone wants your review, OK or sign-off
 *   question   someone asked you something, or asked you to do something
 *   fyi        nothing is asked of you
 *
 * "Whose turn drives the inbox" (turn.ts) reads the newest message's status:
 * a question or an approval puts the item with you; an FYI never moves it to
 * you on its own, the existing rules decide. So precision beats recall here:
 * a missed ask still reaches you through the item's own kind (a review
 * request, a reply pending), while a false ask pings you for nothing. When
 * unsure, it's an FYI.
 *
 * Deterministic signals only, in this order (the first match wins):
 *   1. empty, or your own message                       → fyi
 *   2. the source says it asks (a review request event,
 *      a job's filed ask)                                → approval / question
 *   3. a bot wrote it                                    → fyi
 *   4. it says it's an FYI ("no action needed")          → fyi
 *   5. it isn't addressed to you (no mention, not a DM,
 *      not on your own thread)                           → fyi
 *   6. an approval phrase ("can you approve", "PTAL",
 *      "ok to merge?")                                   → approval
 *   7. a question mark, or a request phrase ("can you",
 *      "let me know", "wdyt")                            → question
 *   8. anything else                                     → fyi
 *
 * The text read for 3–8 is the message with quoted lines, code and links
 * taken out: a quoted question from last week, a `?` in a URL or a snippet
 * isn't an ask.
 *
 * Any source fits: `messageOf` reads a GitHub comment or review request, a
 * Slack message, a work item a job filed, and any other shape that carries
 * text in `text`, `body`, `message` or `content`.
 */
import { askOf, isAsk } from './asks.js'
import type { ItemKind } from './types.js'

export type MessageStatus = 'fyi' | 'question' | 'approval'
export const MESSAGE_STATUSES: readonly MessageStatus[] = ['fyi', 'question', 'approval']

/** Why it got that status. A closed union: each reason implies one status. */
export type StatusReason =
  // approval
  | 'review-request'
  | 'approval-request'
  | 'approval-ask'
  // question
  | 'source-asks'
  | 'direct-question'
  | 'direct-request'
  // fyi
  | 'empty'
  | 'own-message'
  | 'bot'
  | 'says-fyi'
  | 'not-addressed'
  | 'no-ask'

export const STATUS_REASONS: Record<StatusReason, { status: MessageStatus; text: string }> = {
  'review-request': { status: 'approval', text: 'You were asked to review' },
  'approval-request': { status: 'approval', text: 'Your OK was asked for' },
  'approval-ask': { status: 'approval', text: 'They ask for your review or OK' },
  'source-asks': { status: 'question', text: 'The source says it waits on you' },
  'direct-question': { status: 'question', text: 'They asked you a question' },
  'direct-request': { status: 'question', text: 'They asked you to do something' },
  empty: { status: 'fyi', text: 'No message text to read' },
  'own-message': { status: 'fyi', text: 'You wrote it' },
  bot: { status: 'fyi', text: 'A bot wrote it' },
  'says-fyi': { status: 'fyi', text: 'It says nothing is needed' },
  'not-addressed': { status: 'fyi', text: 'Not addressed to you' },
  'no-ask': { status: 'fyi', text: 'Nothing is asked of you' },
}

export const STATUS_REASON_LIST = Object.keys(STATUS_REASONS) as StatusReason[]

export interface StatusOf {
  status: MessageStatus
  reason: StatusReason
}

/** One message, from any source, in the words statusOf reads. */
export interface Message {
  /** github, slack, linear, job, or any MCP server's name */
  source: string
  text: string
  /** who wrote it: a login, a Slack user id, a name */
  author?: string
  /** a bot wrote it (GitHub `type: Bot`, Slack `bot_id`) */
  bot?: boolean
  /**
   * what the source itself says it asks, no text read: a GitHub review
   * request, an approval a tool asks for, a job's filed ask
   */
  asks?: 'review' | 'approval' | 'question'
  /** addressed to you by where it sits: a DM, your own PR or thread, a mention item */
  direct?: boolean
  /** handles the source lists as mentioned; the text's own @mentions are read too */
  mentions?: string[]
}

/** Who you are, in every source: GitHub login, Slack user id and name, Linear name. */
export interface Me {
  handles: readonly string[]
}

const at = (reason: StatusReason): StatusOf => ({ status: STATUS_REASONS[reason].status, reason })

/** Logins that read as bots: `dependabot[bot]`, `renovate-bot`, `ci-bot`. */
const BOT_LOGIN = /\[bot\]$|(^|[-_])bot$/i

/** A login that reads as a bot (`dependabot[bot]`, `ci-bot`). */
export const isBotLogin = (login: string): boolean => BOT_LOGIN.test(login.trim().replace(/^@/, ''))

/**
 * Lines and spans that aren't the author asking anything now: quoted replies
 * (`> …`), fenced and inline code, links (Slack `<https://…|label>` keeps its
 * label), and bare URLs, whose `?` is a query string.
 */
export function plainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(&gt;|>)/.test(line))
    .join('\n')
    .replace(/<(https?:\/\/|mailto:)[^>|]*\|([^>]*)>/g, ' $2 ')
    .replace(/<(https?:\/\/|mailto:)[^>]*>/g, ' ')
    .replace(/\]\((https?:\/\/|mailto:)[^)]*\)/g, '] ')
    .replace(/\b(https?:\/\/|www\.)\S+/g, ' ')
}

/**
 * Handles mentioned in the text: GitHub `@login` and `@org/team` (not an
 * email's `a@b`), Slack `<@U123>` and `<@U123|name>`. Broadcasts (`@here`,
 * `<!channel>`) aren't anyone in particular, so they never count.
 */
export function mentionsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/<@([A-Z0-9]+)(?:\|([^>]+))?>/gi)) {
    out.push(m[1]!)
    if (m[2]) out.push(m[2])
  }
  for (const m of text.matchAll(/(^|[^\w@./`])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]+)?)/g)) {
    const h = m[2]!
    if (!/^(here|channel|everyone|all)$/i.test(h)) out.push(h)
  }
  return [...new Set(out)]
}

// The phrase lists. Kept short on purpose: each one is something people
// write when they want a person to act, and rarely write otherwise.

/** It says outright that nothing is needed. Beats any phrase below. */
const SAYS_FYI: readonly RegExp[] = [
  /\bno (action|reply|response|review)( is)? (needed|required|necessary)\b/i,
  /\bno need (for you )?to (reply|respond|review|approve|act|do anything|look)\b/i,
  /\bnothing (needed|required) from you\b/i,
  /\b(you )?(don['’]t|do not) need to (reply|respond|review|approve|do anything|act|look)\b/i,
  /\bjust (an? )?fyi\b/i,
  /\bfyi only\b/i,
  /\bfor (your )?(visibility|awareness)\b/i,
]

/** It asks for your review, approval or sign-off. */
const APPROVAL: readonly RegExp[] = [
  /\b(can|could|would|will) you (please |pls )?(approve|review|re-?review|sign off( on)?|stamp|give (this|it) a stamp)\b/i,
  /\b(please|pls) (approve|review|re-?review|sign off( on)?|stamp)\b/i,
  /\b(need|needs|waiting (on|for)) your (approval|review|sign-?off|ok|okay|go-ahead|green light)\b/i,
  /\b(approval|sign-?off|review) (needed|required) from you\b/i,
  /\bptal\b/i,
  /\b(please|pls|can you|could you) take (a|another) look\b/i,
  /\b(ok|okay|good|safe|fine|alright) to (merge|ship|deploy|release|land)\b[^.!\n]*\?/i,
  /\b(can|may|should) (i|we) (merge|ship|deploy|release|land)\b[^.!\n]*\?/i,
  /\blgtm\s*\?/i,
]

/** It asks you to do or answer something, without a `?`. */
const REQUEST: readonly RegExp[] = [
  /\b(can|could|would|will) (you|u)\b/i,
  /\b(do|would) you mind\b/i,
  /\bif you (could|can|get a (chance|sec|minute|moment))\b/i,
  /\b(please|pls) (take a look|have a look|look( at)?|check|confirm|advise|help|weigh in|chime in|respond|reply|answer|let me know|share|send|update|fix|verify|clarify|investigate)\b/i,
  /\b(let me know|lmk|wdyt|what do you think|any thoughts|your thoughts|thoughts on)\b/i,
  /\bneed your (input|help|eyes|take|opinion|thoughts|call)\b/i,
  /\b(when|whenever) you (get|have) a (chance|sec|second|minute|moment)\b/i,
]

/** A `?` that ends a phrase, or Slack's question emoji. */
const QUESTION_MARK = /\?(?=$|[\s)"'”’*_~,.!])|:question:|❓/

const lower = (s: string) => s.trim().toLowerCase()

/** What a message asks of you, and why. Total: any message gets one answer. */
export function statusOf(msg: Message, me: Me): StatusOf {
  const mine = new Set(me.handles.map(lower).filter(Boolean))
  if (!msg.text.trim() && !msg.asks) return at('empty')
  if (msg.author && mine.has(lower(msg.author))) return at('own-message')

  // The source says so: no text to read.
  if (msg.asks === 'review') return at('review-request')
  if (msg.asks === 'approval') return at('approval-request')
  if (msg.asks === 'question') return at('source-asks')

  if (msg.bot || (msg.author && BOT_LOGIN.test(msg.author))) return at('bot')

  const text = plainText(msg.text)
  if (SAYS_FYI.some((r) => r.test(text))) return at('says-fyi')

  const named = [...(msg.mentions ?? []), ...mentionsIn(text)].some((h) => mine.has(lower(h)))
  if (!msg.direct && !named) return at('not-addressed')

  if (APPROVAL.some((r) => r.test(text))) return at('approval-ask')
  if (QUESTION_MARK.test(text)) return at('direct-question')
  if (REQUEST.some((r) => r.test(text))) return at('direct-request')
  return at('no-ask')
}

// ── messageOf: any source's shape → Message ────────────────────────────────

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/** A person field as GitHub, Linear, Slack or a plain string writes it. */
function personOf(v: unknown): { name?: string; bot: boolean } {
  if (typeof v === 'string') return { name: v || undefined, bot: false }
  if (!isObj(v)) return { bot: false }
  const name = str(v.login) ?? str(v.username) ?? str(v.name) ?? str(v.displayName) ?? str(v.id)
  return { ...(name ? { name } : {}), bot: v.type === 'Bot' || v.is_bot === true }
}

/**
 * Read a message out of any source's shape. Recognises:
 *  - a work item (has `id`, `kind`, `source`): a scanner's or a job's filing.
 *    Its ask is what the source says (review → review, decide → approval,
 *    reply → question). Its title and why are a summary someone wrote of the
 *    thread, not the message, so they aren't read: no ask means no text.
 *  - a GitHub review request event (`event: 'review_requested'`, or a
 *    `requested_reviewer`).
 *  - a GitHub or Linear comment (`body`, `user`).
 *  - a Slack message (`text`, `user`, `bot_id`, `channel_type: 'im'`).
 *  - anything else with `text`, `body`, `message` or `content`, and an
 *    `author`, `from`, `sender` or `user`.
 * `opts` adds what the shape can't say: the source's name, and whether it
 * sits where it's addressed to you (your own PR, your thread).
 */
export function messageOf(raw: unknown, opts: { source?: string; direct?: boolean } = {}): Message {
  const r: Raw = isObj(raw) ? raw : { text: typeof raw === 'string' ? raw : '' }
  const direct = opts.direct === true ? { direct: true } : {}

  // A work item: the scanner or the job already picked its ask.
  if (str(r.id) && str(r.kind) && str(r.source)) {
    const kind = r.kind as ItemKind
    const ask = askOf({ kind, ...(isAsk(r.ask) ? { ask: r.ask } : {}) })
    const asks = ask === 'review' ? 'review' : ask === 'decide' ? 'approval' : ask === 'reply' ? 'question' : undefined
    return {
      source: opts.source ?? (r.source as string),
      text: '',
      ...(str(r.author) ? { author: r.author as string } : {}),
      ...(asks ? { asks } : {}),
      ...direct,
    }
  }

  // A GitHub review request: the event is the ask.
  if (r.event === 'review_requested' || r.action === 'review_requested' || isObj(r.requested_reviewer)) {
    const who = personOf(r.actor ?? r.sender ?? r.user)
    return { source: opts.source ?? 'github', text: str(r.body) ?? '', ...(who.name ? { author: who.name } : {}), asks: 'review', ...direct }
  }

  const text = str(r.text) ?? str(r.body) ?? str(r.message) ?? str(r.content) ?? ''
  const who = personOf(r.author ?? r.from ?? r.sender ?? r.user)
  const slackBot = typeof r.bot_id === 'string' || r.subtype === 'bot_message'
  const dm = r.channel_type === 'im' || r.is_im === true
  const mentions = Array.isArray(r.mentions) ? r.mentions.map(personOf).flatMap((p) => (p.name ? [p.name] : [])) : []
  const source = opts.source ?? str(r.source) ?? (typeof r.ts === 'string' || slackBot || dm ? 'slack' : isObj(r.user) && 'login' in r.user ? 'github' : 'unknown')
  return {
    source,
    text,
    ...(who.name ? { author: who.name } : {}),
    ...(who.bot || slackBot ? { bot: true } : {}),
    ...(dm || opts.direct ? { direct: true } : {}),
    ...(mentions.length ? { mentions } : {}),
  }
}

/** The newest message's status decides; no messages is no ask. */
export function latestStatus(statuses: readonly StatusOf[]): MessageStatus {
  return statuses.at(-1)?.status ?? 'fyi'
}
