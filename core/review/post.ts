/**
 * Posting a first-pass review (M3 plan artifact 44f4c284, step 3): the one
 * GitHub review the card sends when you OK it, built from the pass as you
 * edited it. GitHub refuses the whole review (422) if one inline comment sits
 * on a line the diff doesn't show, so each comment is checked against the
 * diff's hunks first; one that misses moves into the body with its file:line.
 *
 * Pure: the payload, the diff's lines, and the edit you posted with.
 */
import { isVerdict, MAX_COMMENTS, VERDICT_LABEL, type FirstPass, type ReviewComment, type Verdict } from './brief.js'

/** Lines a review comment may sit on, per file: RIGHT = the new file, LEFT = the old one. */
export type DiffLines = Map<string, { right: Set<number>; left: Set<number> }>

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** A unified diff (`gh pr diff`, or a compare's) → the lines its hunks show. */
export function diffLines(diff: string): DiffLines {
  const out: DiffLines = new Map()
  let file: { right: Set<number>; left: Set<number> } | null = null
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null
      inHunk = false
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p === '/dev/null') continue
      const path = p.replace(/^b\//, '')
      file = out.get(path) ?? { right: new Set(), left: new Set() }
      out.set(path, file)
      continue
    }
    if (!inHunk && line.startsWith('--- ')) continue
    const h = HUNK.exec(line)
    if (h) {
      oldLine = Number(h[1])
      newLine = Number(h[2])
      inHunk = true
      continue
    }
    if (!inHunk || !file) continue
    if (line.startsWith('+')) file.right.add(newLine++)
    else if (line.startsWith('-')) file.left.add(oldLine++)
    else if (line.startsWith(' ') || line === '') {
      file.right.add(newLine++)
      file.left.add(oldLine++)
    } else if (line.startsWith('\\')) continue
    else inHunk = false
  }
  return out
}

export const onDiff = (lines: DiffLines, c: ReviewComment) => {
  const f = lines.get(c.path)
  return !!f && (c.side === 'LEFT' ? f.left : f.right).has(c.line)
}

/** What you changed on the card: any of these, the rest is the pass as Junior wrote it. */
export type PostEdit = { verdict?: Verdict; body?: string; comments?: ReviewComment[] }

/** A posted edit from the wire, validated; anything malformed is an error, not a guess. */
export function postEditFrom(raw: unknown): PostEdit {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: PostEdit = {}
  if (r.verdict !== undefined) {
    if (!isVerdict(r.verdict)) throw new Error('verdict must be approve, comment or request_changes')
    out.verdict = r.verdict
  }
  if (r.body !== undefined) {
    if (typeof r.body !== 'string' || r.body.length > 20_000) throw new Error('body must be text')
    out.body = r.body
  }
  if (r.comments !== undefined) {
    if (!Array.isArray(r.comments) || r.comments.length > MAX_COMMENTS * 2) throw new Error('comments must be a list')
    out.comments = r.comments.map((c, i) => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
      if (typeof o.path !== 'string' || !o.path || typeof o.line !== 'number' || !Number.isInteger(o.line) || o.line < 1 || typeof o.body !== 'string')
        throw new Error(`comment ${i + 1} needs a path, a line and a body`)
      return { path: o.path, line: o.line, ...(o.side === 'LEFT' ? { side: 'LEFT' as const } : {}), body: o.body }
    })
  }
  return out
}

const EVENT: Record<Verdict, 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'> = { approve: 'APPROVE', comment: 'COMMENT', request_changes: 'REQUEST_CHANGES' }

export type ReviewPayload = {
  commit_id: string
  event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'
  body: string
  comments: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
}

/**
 * The review as GitHub takes it (POST /repos/{repo}/pulls/{n}/reviews),
 * anchored to the head the pass read. Empty comments are dropped; comments
 * off the diff are folded into the body. A comment or request-changes review
 * needs words somewhere, so one with none is refused here, not by GitHub.
 */
export function reviewPayload(pass: FirstPass, edit: PostEdit, lines: DiffLines): { payload: ReviewPayload; inline: number; folded: number } {
  const verdict = edit.verdict ?? pass.verdict
  const comments = (edit.comments ?? pass.comments).map((c) => ({ ...c, body: c.body.trim() })).filter((c) => c.body)
  const inline = comments.filter((c) => onDiff(lines, c))
  const off = comments.filter((c) => !onDiff(lines, c))
  const parts = [(edit.body ?? pass.summary).trim()]
  if (off.length) parts.push(off.map((c) => `**\`${c.path}:${c.line}\`**: ${c.body}`).join('\n\n'))
  const body = parts.filter(Boolean).join('\n\n')
  if (verdict !== 'approve' && !body && inline.length === 0) throw new Error(`a ${VERDICT_LABEL[verdict].toLowerCase()} review needs a body or a comment`)
  if (verdict === 'request_changes' && !body) throw new Error('say what has to change in the body')
  return {
    payload: { commit_id: pass.sha, event: EVENT[verdict], body, comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })) },
    inline: inline.length,
    folded: off.length,
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The posted task's line and the log's: "Posted: Request changes · 2 comments". */
export function postedLine(p: ReviewPayload): string {
  const verdict = p.event === 'APPROVE' ? 'Approve' : p.event === 'COMMENT' ? 'Comment' : 'Request changes'
  return `Posted: ${[verdict, ...(p.comments.length ? [plural(p.comments.length, 'comment')] : [])].join(' · ')}`
}
