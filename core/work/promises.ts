/**
 * Your own promises, spotted in text (plan item `promise-core`): "I'll look
 * tomorrow", "will fix in a follow-up", "I owe Dev a review". A promise made
 * in Slack is often kept in GitHub, so Junior reads the user's own words on
 * any source and files what they said they would do.
 *
 * High precision over recall: a missed promise costs nothing new, a made-up
 * one is a row the user has to dismiss. So a sentence counts only when
 *
 *   - the user wrote it (`authoredByUser`; anyone else's text is never read),
 *   - it has a first-person future ("I'll", "I will", "I'm going to",
 *     "we'll", a sentence-leading "Will …", "let me … <time>") followed by
 *     a work verb from a fixed list (look, fix, review, send, get back …),
 *     or is one of a few set phrases ("on it", "I owe Dev", "on my list"),
 *   - it is not a question, an offer ("want me to …", "should I …"), or
 *     hedged ("maybe", "might", "if", "unless", "try to", "not sure").
 *
 * Quoted text is not the user's promise: lines starting with ">", code
 * blocks, inline code and "…" quotes are blanked before reading.
 *
 * `due` is read by shared/when.ts from the promise's own sentence; "today"
 * and "this week" mean their end (17:00 today, Friday 17:00). `owedTo` is
 * who the promise is to, read off the text (I owe X, get back to X, let X
 * know, an @mention, "Dev, …" at the start) or, for "you", the person the
 * message replies to (`ctx.replyTo`).
 *
 * Pure and browser-safe: the reference time is always an argument.
 */
import { parseWhen, type When } from '../../shared/when.js'

export interface PromiseHit {
  /** The sentence that makes the promise, exactly as written. */
  quote: string
  /** When it is due, when the sentence says ("tomorrow", "by EOD"). */
  due?: When
  /** Who it is owed to, when known: a name, a handle, or a Slack user id. */
  owedTo?: string
}

export interface PromiseContext {
  /** The person this message replies to; "you" in the promise means them. */
  replyTo?: string
}

/** Longer text is cut here; a chat message past it is a document, not a reply. */
const MAX_TEXT = 4000
/** A quote longer than this is cut with an ellipsis. */
const MAX_QUOTE = 240

// ── Cleaning ──────────────────────────────────────────────────────────────

/** Replace every non-newline character with a space, so indices still match. */
const blank = (s: string) => s.replace(/[^\n]/g, ' ')

/**
 * The text with everything that isn't the user's own prose blanked out:
 * code blocks, inline code, quoted lines, "…" quotes, URLs. Same length as
 * the input, so a sentence found here slices the original exactly.
 */
function clean(text: string): string {
  return text
    .replace(/’|‘/g, "'")
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(/^[ \t]*>.*$/gm, blank)
    .replace(/"[^"\n]*"|“[^”\n]*”/g, blank)
    .replace(/\bhttps?:\/\/\S+/g, blank)
    .replace(/<https?:[^>\s]*>/g, blank)
}

interface Sentence {
  start: number
  end: number
  text: string
}

/** Sentences end at a newline, or at . ! ? followed by space or the end. */
function sentences(text: string): Sentence[] {
  const out: Sentence[] = []
  let start = 0
  const push = (end: number) => {
    const raw = text.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const s = raw.trim()
    if (s) out.push({ start: start + lead, end: start + lead + s.length, text: s })
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\n') {
      push(i)
      start = i + 1
    } else if ((c === '.' || c === '!' || c === '?') && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      push(i + 1)
      start = i + 1
    }
  }
  push(text.length)
  return out
}

// ── The phrase list ───────────────────────────────────────────────────────

/** Work verbs a promise is made of. Each is a regex fragment. */
const VERBS = [
  'look(?:\\s+(?:into|at|over))?',
  'have\\s+a\\s+(?:look|peek|go)',
  'take\\s+(?:a\\s+)?(?:look|peek|pass|stab|care|over)',
  'take\\s+(?:it|this|that|these|those)',
  'check',
  'double[- ]?check',
  'review',
  'fix',
  'send',
  'follow[- ]?up',
  'get\\s+back',
  'circle\\s+back',
  'loop\\s+back',
  'come\\s+back\\s+to',
  'get\\s+(?:to|on|onto)',
  'reply',
  'respond',
  'answer',
  'update',
  'add',
  'write(?:\\s+up)?',
  'push',
  'merge',
  'open',
  'file',
  'create',
  'handle',
  'deal\\s+with',
  'investigate',
  'dig(?:\\s+(?:into|in))?',
  'sort\\s+(?:it|this|that)?\\s*out',
  'test',
  'rebase',
  'address',
  'ping',
  'share',
  'post',
  'draft',
  'finish',
  'do(?=\\s+(?:it|this|that|the|a|so)\\b|\\s*[!.]?\\s*$)',
  'revert',
  'land',
  'deploy',
  'release',
  'ship',
  'cut',
  'bump',
  'patch',
  'debug',
  'repro(?:duce)?',
  'pick\\s+(?:it|this|that)\\s+up',
  'pick\\s+up',
  'set\\s+up',
  'put\\s+(?:together|up)',
  'read',
  'approve',
  're-?run',
  'run',
  'sync',
  'schedule',
  'book',
  'document',
  'raise',
  'make\\s+sure',
  'change',
  'clean\\s+up',
  'refactor',
  'move',
  'close',
  'comment',
  'message',
  'email',
  'call',
  'let\\s+(?:you|u|them|him|her|everyone|the\\s+team|[A-Z][\\w.-]*)\\s+know',
  'confirm',
  'verify',
  'own',
  'grab',
  'jump\\s+on',
  'hop\\s+on',
  'prepare',
  'explain',
  'tag',
  'remove',
  'delete',
  'split',
  'resolve',
  'tackle',
  'work\\s+on',
  'start\\s+on',
  'implement',
  'submit',
]

const VERB = `(?:${VERBS.join('|')})\\b`
/** Words that may sit between the subject and the verb: "I'll also go ahead and fix". */
const FILL = '(?:(?:also|definitely|def|just|quickly|first|then|still|now|totally|surely|happily|personally|actually|gladly|go\\s+ahead\\s+and|go|and)\\s+){0,3}'
const SUBJECT = "(?:i'll|i\\s+will|i'm\\s+going\\s+to|i\\s+am\\s+going\\s+to|i'm\\s+gonna|i\\s+am\\s+gonna|gonna|i\\s+plan\\s+to|i\\s+intend\\s+to|i\\s+promise\\s+to|i'll\\s+make\\s+sure\\s+to|we'll|we\\s+will|we're\\s+going\\s+to)"

/** "I'll look tomorrow", "we'll fix it in the next release". */
const FUTURE_RE = new RegExp(`\\b${SUBJECT}\\s+${FILL}${VERB}`, 'i')
/** "Will fix in a follow-up", "Good catch, will do." The "Will" leads its clause. */
const BARE_WILL_RE = new RegExp(`(?:^|[,;:—–-]\\s*|\\b(?:ok(?:ay)?|sure|yep|yes|ack|thanks|ty|np)\\s+)will\\s+${FILL}${VERB}`, 'i')
/** "Let me check": a promise only with a time ("let me look tomorrow"), else it's in-the-moment. */
const LET_ME_RE = new RegExp(`\\blet\\s+me\\s+${FILL}${VERB}`, 'i')
/** Set phrases that promise without a verb from the list. */
const SET_PHRASES: RegExp[] = [
  /^(?:(?:ok(?:ay)?|sure|yep|yes|ack|thanks)[\s,!]+)?(?:i'm\s+|i\s+am\s+)?on\s+it\b(?!\s+(?:being|was|is)\b)/i,
  /\b[Ii]\s+owe\s+(?:you|u|@[\w.-]+|<@[A-Z0-9]+(?:\|[^>]+)?>|[A-Z][\w.-]*)\s+(?:a|an|the|my|some|one\s+more)\s+(?:review|reply|answer|response|update|look|pr|PR|fix|doc|write-?up|follow-?up|explanation|patch|test)s?\b/,
  /\b(?:add(?:ed|ing)?|put(?:ting)?)\s+(?:it\s+|this\s+|that\s+)?(?:on|to)\s+my\s+(?:list|todo|to-do|plate)\b/i,
  /\b(?:it'?s|this\s+is|that'?s)\s+on\s+my\s+(?:list|todo|to-do)\b/i,
  /\bleave\s+it\s+with\s+me\b/i,
  /\bi(?:'ve|\s+have)?\s+got\s+this\s*[!.]*$/i,
]

/** A question or an offer asks; it doesn't promise. */
const ASKING_RE = /^(?:(?:ok(?:ay)?|sure|so|hey|hi)[\s,]+)?(?:should|shall|can|could|would|do|did|does|want)\s+(?:i|we|you)\b|\bwant\s+me\s+to\b|\b(?:do|would)\s+you\s+(?:like|want)\b/i
/** Hedged: not a commitment. "check if" and "see if" are "whether", not a condition. */
const HEDGE_RE =
  /\b(?:maybe|might|probably|perhaps|hopefully|possibly|not\s+sure|(?:don't|do\s+not)\s+think|doubt|unlikely|unless|tr(?:y|ying)\s+to)\b|(?<!\b(?:check|see|verify|confirm|know|ask|test|find\s+out|figure\s+out|look)\s)\bif\b/i

// ── Due ───────────────────────────────────────────────────────────────────

/** Refs a time reader could take for a time: "#123", "PR 42", "v1.2". */
const REF_RE = /#\d+|\b(?:pr|issue|ticket)\s+\d+\b|\bv\d+(?:\.\d+)*\b/gi

function dueOf(sentence: string, at: number): When | undefined {
  const s = sentence.replace(REF_RE, (m) => ' '.repeat(m.length))
  const when = parseWhen(s, at)
  // "this week" means by Friday 17:00, not the next morning chrono reads.
  if ((!when || /^this\s+week$/i.test(when.text)) && /\bthis\s+week\b/i.test(s)) {
    return parseWhen('end of week', at) ?? undefined
  }
  if (when) return when
  // "today" alone has passed its 9:00 by the time anyone promises; it means
  // by the end of today.
  if (/\b(?:later\s+)?today\b/i.test(s)) return parseWhen('eod', at) ?? undefined
  return undefined
}

// ── Owed to ───────────────────────────────────────────────────────────────

/** Capitalised words that aren't people. */
const NOT_A_NAME = new Set(
  [
    'i', 'you', 'we', 'it', 'this', 'that', 'the', 'a', 'an', 'ok', 'okay', 'sure', 'yes', 'yep', 'no', 'thanks', 'thank',
    'hey', 'hi', 'hello', 'sounds', 'good', 'great', 'nice', 'cool', 'ack', 'np', 'will', 'all', 'team', 'everyone', 'folks',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'tonight',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec', 'eod', 'eow', 'cob',
    'pr', 'prs', 'ci', 'qa', 'api', 'ui', 'ux', 'mr', 'main', 'master', 'prod', 'staging', 'github', 'slack', 'linear',
    'jira', 'notion', 'sentry', 'pagerduty', 'junior', 'on', 'got', 'lgtm', 'in', 'progress', 'done', 'review',
    'backlog', 'todo', 'next', 'later', 'then', 'now', 'there', 'here', 'it\'s',
  ],
)

function person(raw: string | undefined, ctx: PromiseContext): string | undefined {
  if (!raw) return undefined
  const slack = /^<@([A-Z0-9]+)(?:\|([^>]+))?>$/.exec(raw)
  if (slack) return slack[2] ?? slack[1]
  const name = raw.replace(/^@/, '').replace(/[.,:;!?]+$/, '').replace(/'s$/i, '')
  const lower = name.toLowerCase()
  if (lower === 'you' || lower === 'u' || lower === 'y\'all') return ctx.replyTo || undefined
  if (!name || NOT_A_NAME.has(lower)) return undefined
  return name
}

const NAME = "(@[\\w.-]+|<@[A-Z0-9]+(?:\\|[^>]+)?>|you|u|[A-Z][\\w.'-]*)"
/** Phrases that name who a promise is to, in the promise's own sentence. */
const OWED_RES: RegExp[] = [
  new RegExp(`\\bowe\\s+${NAME}`),
  new RegExp(`\\b(?:get|circle|loop|come)\\s+back\\s+to\\s+${NAME}`),
  new RegExp(`\\bfollow[- ]?up\\s+with\\s+${NAME}`),
  new RegExp(`\\blet\\s+${NAME}\\s+know\\b`),
  new RegExp(`\\b(?:ping|send|email|message|call|update)\\s+${NAME}\\b`),
  new RegExp(`\\b(?:for|to)\\s+${NAME}\\b`),
]
const LEADING_MENTIONS_RE = /^(?:(?:@[\w.-]+|<@[A-Z0-9]+(?:\|[^>]+)?>)[\s,:]*)+/
const MENTION_RE = /@[\w.-]+|<@[A-Z0-9]+(?:\|[^>]+)?>/
/** "Dev, I'll look" / "Thanks Dev — on it": the name the message opens on. */
const VOCATIVE_RE = /^\s*(?:(?:[Hh]ey|[Hh]i|[Tt]hanks|[Tt]hank\s+you|[Tt]hx|[Tt]y|[Oo]k(?:ay)?|OK|[Ss]ure|[Yy]ep|[Yy]es)[\s,!]+)?([A-Z][\w.'-]*)\s*(?:[,:]|\s[—–-]\s)/

function owedOf(sentence: string, message: string, ctx: PromiseContext): string | undefined {
  for (const re of OWED_RES) {
    const m = re.exec(sentence)
    const who = person(m?.[1], ctx)
    if (who) return who
  }
  const inSentence = person(MENTION_RE.exec(sentence)?.[0], ctx)
  if (inSentence) return inSentence
  const opener = person(VOCATIVE_RE.exec(message)?.[1], ctx)
  if (opener) return opener
  const inMessage = person(MENTION_RE.exec(message)?.[0], ctx)
  if (inMessage) return inMessage
  return ctx.replyTo || undefined
}

// ── Detecting ─────────────────────────────────────────────────────────────

/** Does this one sentence (already cleaned) make a promise? */
export function isPromise(sentence: string, at: number): boolean {
  // "@dev on it": the mentions a reply opens on are who, not what.
  const s = sentence.trim().replace(LEADING_MENTIONS_RE, '')
  if (!s || s.endsWith('?')) return false
  if (ASKING_RE.test(s) || HEDGE_RE.test(s)) return false
  if (FUTURE_RE.test(s) || BARE_WILL_RE.test(s)) return true
  if (SET_PHRASES.some((re) => re.test(s))) return true
  return LET_ME_RE.test(s) && dueOf(s, at) !== undefined
}

function quoteOf(original: string, s: Sentence): string {
  const q = original.slice(s.start, s.end).replace(/\s+/g, ' ').trim()
  return q.length > MAX_QUOTE ? `${q.slice(0, MAX_QUOTE - 1).trimEnd()}…` : q
}

/**
 * Every promise in a message the user wrote, in order. Text by anyone else
 * returns none.
 */
export function detectPromises(text: string, authoredByUser: boolean, at: number, ctx: PromiseContext = {}): PromiseHit[] {
  if (!authoredByUser || typeof text !== 'string' || !Number.isFinite(at)) return []
  const original = text.slice(0, MAX_TEXT)
  const cleaned = clean(original)
  if (!cleaned.trim()) return []
  const out: PromiseHit[] = []
  for (const s of sentences(cleaned)) {
    if (!isPromise(s.text, at)) continue
    const hit: PromiseHit = { quote: quoteOf(original, s) }
    const due = dueOf(s.text, at)
    if (due) hit.due = due
    const owedTo = owedOf(s.text, cleaned, ctx)
    if (owedTo) hit.owedTo = owedTo
    out.push(hit)
  }
  return out
}

/**
 * The first promise in a message the user wrote, or null. Only the user's
 * own text is read: `authoredByUser` false is always null.
 */
export function detectPromise(text: string, authoredByUser: boolean, at: number, ctx: PromiseContext = {}): PromiseHit | null {
  return detectPromises(text, authoredByUser, at, ctx)[0] ?? null
}
