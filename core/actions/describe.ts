/**
 * The words on an action's card: a title that says what happened ("Opened PR
 * #2 · stage + turn", "Pushed feat/x", "Created PX-197 · Fix the scheduler"),
 * never the bare word "Action"; and why it counted, in plain words ("matches
 * `git push`", "“send” in the tool name"), never the actions file's pattern
 * grammar. Pure; the server puts both on every record it serves.
 */
import { matchPart, parsePattern, splitCommand, unwrap } from './bash.js'
import { bashPatternsOf, leafOf, wordsOf } from './sort.js'
import type { ActionRecord } from './types.js'

type Rec = Pick<ActionRecord, 'kind' | 'status' | 'summary' | 'args' | 'link' | 'groupKey' | 'tool' | 'why' | 'whyDetail'>

const one = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => {
  const t = one(s)
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** The part of a summary after "Create issue: " / "gh pr create: " — what it named. */
function named(summary: string): string | null {
  const i = summary.indexOf(': ')
  return i > 0 && i < 60 ? summary.slice(i + 2).trim() || null : null
}

/** "PR #2", "issue #14", "PX-197" — what a link (or a gh command) points at. */
function refOf(link: string | null, summary: string): { pr?: string; issue?: string; key?: string } {
  const out: { pr?: string; issue?: string; key?: string } = {}
  const pr = link && /\/pull\/(\d+)/.exec(link)
  if (pr) out.pr = `PR #${pr[1]}`
  const issue = link && /\/issues\/(\d+)/.exec(link)
  if (issue) out.issue = `issue #${issue[1]}`
  const key = link && /\/(?:issue|browse|issues)\/([A-Z][A-Z0-9]{1,9}-\d+)\b/.exec(link)
  if (key) out.key = key[1]
  // `gh pr comment 2784`, `gh issue close 12`: the number the command names.
  const gh = /^gh (pr|issue) [a-z]+ #?(\d+)\b/.exec(summary)
  if (gh) {
    if (gh[1] === 'pr' && !out.pr) out.pr = `PR #${gh[2]}`
    if (gh[1] === 'issue' && !out.issue) out.issue = `issue #${gh[2]}`
  }
  return out
}

/** A push's branch, from its group key (`push:<session>:<branch>`) or its link. */
function branchOf(r: Rec): string | null {
  const g = r.groupKey?.startsWith('push:') ? r.groupKey.split(':').slice(2).join(':') : ''
  if (g && g !== '?') return g
  const t = r.link && /\/tree\/(.+)$/.exec(r.link)
  return t ? decodeURIComponent(t[1]) : null
}

/** A Slack-ish channel id (C0123ABCD) says nothing to a person. */
const looksLikeId = (s: string) => /^[CDGU][A-Z0-9]{7,}$/.test(s)

/**
 * The card's title. Past tense once it went out ("Opened", "Pushed",
 * "Created"); the ask before it has ("Open a PR", "Send a message").
 */
export function actionTitle(r: Rec): string {
  const done = r.status === 'succeeded'
  const a = r.args
  const what = str(a.title) ?? str(a.subject) ?? named(r.summary) ?? str(a.name)
  const text = str(a.text) ?? str(a.message) ?? str(a.body) ?? str(a.content) ?? str(a.comment) ?? str(a.markdown)
  const ref = refOf(r.link, r.summary)
  const tail = (s: string | null) => (s ? ` · ${clip(s, 80)}` : '')
  let title: string
  switch (r.kind) {
    case 'pr':
      title = `${done ? 'Opened' : 'Open'} ${ref.pr ?? 'a PR'}${tail(what)}`
      break
    case 'push': {
      const b = branchOf(r)
      title = `${done ? 'Pushed' : 'Push'} ${b ?? 'a branch'}`
      break
    }
    case 'merge':
      title = `${done ? 'Merged' : 'Merge'} ${ref.pr ?? 'a PR'}`
      break
    case 'ticket':
      title = `${done ? 'Created' : 'Create'} ${ref.key ?? ref.issue ?? 'a ticket'}${tail(what)}`
      break
    case 'comment': {
      const on = ref.pr ?? ref.issue ?? ref.key
      title = `${done ? 'Commented' : 'Comment'}${on ? ` on ${on}` : ''}${tail(on ? null : text ?? what)}`
      break
    }
    case 'message': {
      const ch = str(a.channel_name) ?? str(a.channel)
      const to = ch && !looksLikeId(ch) ? (ch.startsWith('#') ? ch : `#${ch}`) : null
      title = `${done ? 'Sent' : 'Send'} a message${to ? ` in ${to}` : ''}${tail(text ?? what)}`
      break
    }
    case 'email': {
      const to = str(a.to) ?? (Array.isArray(a.to) ? a.to.filter((x): x is string => typeof x === 'string').join(', ') || null : null)
      title = `${done ? 'Sent' : 'Send'} an email${to ? ` to ${clip(to, 40)}` : ''}${tail(str(a.subject) ?? what)}`
      break
    }
    case 'post': {
      const sched = wordsOf(leafOf(r.tool)).includes('schedule')
      title = `${sched ? (done ? 'Scheduled' : 'Schedule') : done ? 'Posted' : 'Post'}${sched ? ' a post' : ''}${tail(text ?? what)}`
      break
    }
    case 'release':
      title = `${done ? 'Released' : 'Release'}${tail(what ?? r.summary)}`
      break
    case 'update': {
      const on = ref.key ?? ref.issue ?? ref.pr
      title = `${done ? 'Updated' : 'Update'}${on ? ` ${on}` : ''}${tail(what ?? (on ? null : r.summary))}`
      break
    }
    default:
      title = r.summary || leafOf(r.tool)
  }
  return clip(title, 140)
}

/**
 * The leading words of the command part a pattern matched — "git push", "gh
 * pr create" — or, without the command, the pattern's own words (first of
 * each alternative, flags left out).
 */
function matchedWords(command: string | null, patternText: string): string {
  const p = parsePattern(patternText)
  if (typeof p === 'string') return patternText
  if (command) {
    for (const part of splitCommand(command)) {
      const at = matchPart(part, p)
      // The pattern's own words as the command spelled them — `git -C dir push` reads "git push".
      if (at >= 0) return unwrap(part).slice(0, Math.max(at, 1)).filter((w) => p.words.some((alts) => alts.includes(w))).join(' ')
    }
  }
  return p.words.map((alts) => alts[0]).join(' ')
}

/** Why it counted, in plain words. */
export function countedText(r: Rec): string {
  if (r.tool === 'Bash' && (r.why === 'bash pattern' || r.why === 'override')) {
    const cmd = str(r.args.command)
    const words = [...new Set(bashPatternsOf(r.whyDetail).map((t) => matchedWords(cmd, t)))]
    const list = words.map((w) => `\`${w}\``).join(' and ')
    if (r.why === 'override') return list ? `you marked ${list} an action` : 'you marked it an action'
    return list ? `matches ${list}` : 'an outbound command'
  }
  switch (r.why) {
    case 'annotation':
      return r.whyDetail === 'destructive' ? 'the server marks it destructive' : 'the server marks it as a write'
    case 'name verb':
      return r.whyDetail ? `“${r.whyDetail}” in the tool name` : 'a write verb in the tool name'
    case 'unknown':
      return 'an unknown tool — counted to be safe'
    case 'override':
      return 'you marked it an action'
    default:
      return 'an outbound command'
  }
}
