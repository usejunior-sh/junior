/**
 * The impact line on a held send: what it does, who sees it, as whom, and
 * whether it can be taken back, from the call's tool and args alone.
 *
 *   Comment on acme/api#3235 · as you · can edit or delete, not unsend
 *   Post in #payments · about 41 members · as you · can edit or delete, not unsend
 *   Sends through Notion · as you
 *
 * Honest by construction: a count shows only when the caller passes it as a
 * known fact (or the args list the people, like `gh pr create -r a,b`), and
 * reads "about" when it was estimated. A tool this file doesn't know gets a
 * generic line and no claim about undo. "As you" holds because Junior holds
 * no credentials: every send runs on your own logins (`gh`, your connectors);
 * a caller that knows otherwise passes `facts.as`.
 *
 * Pure and browser-safe: the server and the web read the same line.
 */
import { splitCommand, unwrap, wrappersOf, type CommandPart } from '../actions/bash.js'
import { kindOfTool, leafOf, serverOf, wordsOf } from '../actions/sort.js'
import type { ActionKind, ActionRecord } from '../actions/types.js'

/** A count from known facts. `estimated` = a guess from data (CODEOWNERS, a cached member list): reads "about". */
export type Count = { n: number; estimated?: boolean }

/** What the caller knows beyond the args. Every field is optional; nothing here is ever guessed. */
export type ImpactFacts = {
  /** owner/name of the session's repo, for a `gh` command that names none */
  repo?: string
  /** the repo's default branch: a push there says so */
  defaultBranch?: string
  /** the checked-out branch, for `git push` with no refspec or HEAD */
  currentBranch?: string
  /** a Slack channel's name for its id (C0123ABCD → payments) */
  channelName?: string
  /** people in the channel a message goes to */
  members?: Count
  /** people asked to review a PR */
  reviewers?: Count
  /** who it goes out as, when it isn't you: "as the deploy bot" */
  as?: string
  /** whether a one-branch push creates the branch on the remote (true) or moves one already there (false) */
  newBranch?: boolean
}

/** The send, as much of a record or a planned card as the line needs. */
export type ImpactInput = Pick<ActionRecord, 'tool' | 'args'> & Partial<Pick<ActionRecord, 'kind' | 'link' | 'groupKey'>>

export type Impact = {
  /** what it does, and where: "Comment on acme/api#3235" */
  what: string
  /** who it reaches, only from known facts: "about 41 members"; null when unknown */
  reach: string | null
  /** "as you" */
  as: string
  /** whether it can be taken back: "can edit or delete, not unsend"; null when we can't say */
  undo: string | null
}

const SEP = ' · '

/** The line itself: what · reach · as · undo, the unknown parts left out. */
export function impactLine(action: ImpactInput, facts: ImpactFacts = {}): string {
  const i = impactOf(action, facts)
  return [i.what, i.reach, i.as, i.undo].filter((s): s is string => !!s).join(SEP)
}

// Undo, in a few honest words per kind of send.
const UNDO = {
  unsend: 'can edit or delete, not unsend',
  email: "can't be unsent",
  pr: 'can close, not delete',
  ticket: 'can close',
  change: 'can change back',
  reopen: 'can reopen',
  review: "can't be deleted, only dismissed",
  note: 'can edit, not unsend',
  push: 'undo needs a force-push or a branch delete',
  pushOld: 'undo needs a force-push',
  pushNew: 'can delete the new branch',
  force: 'overwrites the remote branch',
  merge: 'undo needs a revert',
  release: 'hard to take back',
  delete: 'may not be undoable',
  mirror: 'overwrites and deletes remote branches',
  prune: 'deletes remote branches not here',
  tags: 'undo needs deleting the tags',
  auto: 'can turn off before it merges',
  scheduled: 'can cancel before it sends',
  draft: 'nobody sees it yet',
} as const

const one = (s: string): string => s.replace(/\s+/g, ' ').trim()
const clip = (s: string, n: number): string => {
  const t = one(s)
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? one(v) : typeof v === 'number' && Number.isFinite(v) ? String(v) : null)
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : (str(v)?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])

/** A count that is really a count, or nothing. */
function countText(c: Count | undefined, one: string, many: string): string | null {
  if (!c || !Number.isInteger(c.n) || c.n < 0) return null
  return `${c.estimated ? 'about ' : ''}${c.n} ${c.n === 1 ? one : many}`
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const asOf = (facts: ImpactFacts): string => {
  const a = str(facts.as)
  if (!a) return 'as you'
  return a.toLowerCase().startsWith('as ') ? a : `as ${a}`
}

/** "acme/api#3235", or "PR #3235" when the repo isn't known. */
function refText(repo: string | null, n: string | null, what: 'PR' | 'issue'): string | null {
  if (!n) return repo
  return repo ? `${repo}#${n}` : `${what} #${n}`
}

/** A GitHub URL's repo and number: https://github.com/acme/api/pull/3235. */
function fromUrl(url: string | null | undefined): { repo: string; n: string | null; noun: 'pr' | 'issue' | null } | null {
  const m = url && /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?(?:\/(pull|issues)\/(\d+))?(?=[/?#]|$)/.exec(url)
  return m ? { repo: m[1], n: m[3] ?? null, noun: m[2] === 'pull' ? 'pr' : m[2] === 'issues' ? 'issue' : null } : null
}

/** A connector server's name, the way a person says it: `claude_ai_Slack` → "Slack". */
export function serverName(tool: string): string {
  let s = serverOf(tool)
  s = s.replace(/^claude_ai_/i, '').replace(/^plugin_[^_]+_/i, '')
  const words = s.split(/[_\-\s]+/).filter(Boolean)
  const KNOWN: Record<string, string> = {
    github: 'GitHub',
    gitlab: 'GitLab',
    slack: 'Slack',
    linear: 'Linear',
    gmail: 'Gmail',
    notion: 'Notion',
    sentry: 'Sentry',
    atlassian: 'Atlassian',
    jira: 'Jira',
    pagerduty: 'PagerDuty',
    google: 'Google',
    calendar: 'Calendar',
  }
  return words.map((w) => KNOWN[w.toLowerCase()] ?? w).join(' ') || s
}

/** A Slack id (C0123ABCD channel, D… DM, U… person) says nothing to a person; we show it only with no name. */
const SLACK_ID = /^[CDGUW][A-Z0-9]{7,}$/

/** Where a Slack call goes: "#payments", "a DM", or the raw id when that's all there is. */
function slackPlace(args: Record<string, unknown>, facts: ImpactFacts): { where: string; dm: boolean } {
  const raw = str(args.channel_name) ?? str(args.channel) ?? str(args.channel_id) ?? str(args.user_id) ?? str(args.user)
  const name = str(facts.channelName)
  const dm = !!raw && /^[DUW][A-Z0-9]{7,}$/.test(raw)
  if (dm) return { where: name ? `DM to ${name.startsWith('@') ? name : `@${name}`}` : 'DM', dm }
  const label = name ?? (raw && !SLACK_ID.test(raw) ? raw : null)
  if (label) return { where: `in ${label.startsWith('#') ? label : `#${label}`}`, dm }
  return { where: raw ? `in ${raw}` : 'in Slack', dm }
}

function slackImpact(tool: string, args: Record<string, unknown>, facts: ImpactFacts): Omit<Impact, 'as'> | null {
  if (!wordsOf(serverOf(tool)).includes('slack') && !wordsOf(leafOf(tool)).includes('slack')) return null
  const leaf = wordsOf(leafOf(tool))
  if (!leaf.some((w) => ['send', 'post', 'schedule', 'message', 'reply', 'draft'].includes(w))) return null
  const { where, dm } = slackPlace(args, facts)
  const thread = !!str(args.thread_ts)
  const broadcast = args.reply_broadcast === true
  // "a DM to @priya", "#payments": where it lands, as a phrase.
  const spot = dm ? (where === 'DM' ? 'a DM' : `a ${where}`) : where.replace(/^in /, '')
  if (leaf.includes('draft')) return { what: `Save a Slack draft for ${spot}`, reach: null, undo: UNDO.draft }
  const scheduled = leaf.includes('schedule')
  const what = thread ? `${scheduled ? 'Schedule a reply' : 'Reply'} in a thread in ${spot}` : dm ? `${scheduled ? 'Schedule' : 'Send'} ${spot}` : `${scheduled ? 'Schedule a post' : 'Post'} in ${spot}`
  const reach = [broadcast ? 'also in channel' : null, dm ? null : countText(facts.members, 'member', 'members')].filter(Boolean).join(SEP) || null
  return { what, reach, undo: scheduled ? UNDO.scheduled : UNDO.unsend }
}

/** A GitHub MCP call (owner, repo, issue_number / pull_number). */
function githubMcpImpact(tool: string, args: Record<string, unknown>, facts: ImpactFacts, link: string | null | undefined): Omit<Impact, 'as'> | null {
  if (!wordsOf(serverOf(tool)).includes('github')) return null
  const leaf = wordsOf(leafOf(tool))
  const owner = str(args.owner)
  const name = str(args.repo)
  const landed = fromUrl(link)
  const repo = owner && name ? `${owner}/${name}` : landed?.repo ?? str(facts.repo)
  // The number only from the args, or from where it landed when the args name no repo of their own.
  const fill = (noun: 'pr' | 'issue') => (landed?.noun === noun && (!owner || !name || repo === landed.repo) ? landed.n : null)
  const creates = leaf.includes('create') && !leaf.includes('comment') && !leaf.includes('review')
  const pr = str(args.pull_number) ?? str(args.pullNumber) ?? (creates ? null : fill('pr'))
  const issue = str(args.issue_number) ?? str(args.issueNumber) ?? (creates ? null : fill('issue'))
  const ref = refText(repo, pr ?? issue, pr ? 'PR' : 'issue')
  if (leaf.includes('review')) {
    const ev = (str(args.event) ?? '').toUpperCase()
    const verb = ev === 'APPROVE' ? 'Approve' : ev === 'REQUEST_CHANGES' ? 'Request changes on' : 'Review'
    // Only an approval or a change request can be dismissed; a plain review's note can be edited.
    return { what: `${verb} ${ref ?? 'a PR'}`, reach: null, undo: verb === 'Review' ? UNDO.note : UNDO.review }
  }
  if (leaf.includes('comment') || leaf.includes('reply')) return { what: `Comment on ${ref ?? 'GitHub'}`, reach: null, undo: UNDO.unsend }
  if (leaf.includes('merge')) {
    const into = str(args.base)
    return { what: `Merge ${ref ?? 'a PR'}${into ? ` into ${into}` : ''}`, reach: null, undo: UNDO.merge }
  }
  if ((leaf.includes('pull') || leaf.includes('pr')) && leaf.includes('create')) {
    const draft = args.draft === true
    const base = str(args.base)
    return {
      what: `Open ${draft ? 'a draft PR' : 'a PR'}${repo ? ` in ${repo}` : ''}${base ? ` into ${base}` : ''}`,
      reach: countText(facts.reviewers, 'reviewer', 'reviewers'),
      undo: UNDO.pr,
    }
  }
  if ((leaf.includes('pull') || leaf.includes('pr')) && leaf.includes('update')) {
    if (str(args.state) === 'closed') return { what: `Close ${ref ?? 'a PR'}`, reach: null, undo: UNDO.reopen }
    return { what: `Edit ${ref ?? 'a PR'}`, reach: null, undo: UNDO.change }
  }
  // push_files and create_or_update_file both land a commit on a branch.
  if (leaf.includes('push') || (leaf.includes('file') && (leaf.includes('create') || leaf.includes('update')))) {
    const branch = str(args.branch)
    const where = [branch ? ` to ${branch}` : '', repo ? ` in ${repo}` : ''].join('')
    const isDefault = !!branch && !!facts.defaultBranch && branch === facts.defaultBranch
    return { what: `Push a commit${where}`, reach: isDefault ? 'the default branch' : null, undo: pushUndo(facts, 1) }
  }
  if (leaf.includes('issue') && leaf.includes('create')) return { what: `New issue in ${repo ?? 'GitHub'}`, reach: null, undo: UNDO.ticket }
  if (leaf.includes('issue') && leaf.includes('update')) {
    const state = str(args.state)
    if (state === 'closed') return { what: `Close ${ref ?? 'an issue'}`, reach: null, undo: UNDO.reopen }
    return { what: `Update ${ref ?? 'an issue'}`, reach: null, undo: UNDO.change }
  }
  return null
}

/** Ticket trackers by their args: Linear (id, issueId, state), Jira (issueIdOrKey, transition). */
function ticketImpact(tool: string, args: Record<string, unknown>, kind: ActionKind): Omit<Impact, 'as'> | null {
  const leaf = wordsOf(leafOf(tool))
  // Only a tool that says it works on issues: an arbitrary `update_x` makes no claim about undo.
  if (!leaf.some((w) => ['issue', 'ticket', 'task', 'comment', 'transition'].includes(w))) return null
  const key = str(args.issueIdOrKey) ?? str(args.issueId) ?? str(args.identifier) ?? str(args.id) ?? str(args.issue)
  const svc = serverName(tool)
  if (kind === 'comment' && key) return { what: `Comment on ${key}`, reach: null, undo: UNDO.unsend }
  const state = str(args.state) ?? str(args.status) ?? str((args.transition as { name?: unknown } | undefined)?.name)
  // Linear's save_issue files and updates through one tool: an issue key means it already exists.
  const existing = kind === 'update' || (kind === 'ticket' && !!key)
  if (leaf.includes('transition') || (existing && state)) {
    return { what: `Move ${key ?? `a ${svc} issue`}${state ? ` to ${state}` : ''}`, reach: null, undo: UNDO.change }
  }
  if (kind === 'ticket' && key) return { what: `Update ${key}`, reach: null, undo: UNDO.change }
  if (kind === 'ticket') {
    const where = str(args.projectKey) ?? str(args.team) ?? str(args.teamId) ?? str(args.project)
    return { what: `New issue in ${where ?? svc}`, reach: null, undo: UNDO.ticket }
  }
  if (kind === 'update' && key) {
    if (leaf.includes('delete') || leaf.includes('remove')) return { what: `Delete ${key}`, reach: null, undo: UNDO.delete }
    return { what: `Update ${key}`, reach: null, undo: UNDO.change }
  }
  return null
}

function mailImpact(tool: string, args: Record<string, unknown>, kind: ActionKind): Omit<Impact, 'as'> | null {
  const leaf = wordsOf(leafOf(tool))
  if (kind !== 'email' && !(kind === 'post' && /mail/i.test(serverOf(tool)))) return null
  const to = strs(args.to)
  const cc = [...strs(args.cc), ...strs(args.bcc)]
  const who = to.length ? `${to[0]}${to.length + cc.length > 1 ? ` +${to.length + cc.length - 1}` : ''}` : null
  if (leaf.includes('draft')) return { what: `Save an email draft${who ? ` to ${who}` : ''}`, reach: null, undo: UNDO.draft }
  const reach = to.length + cc.length > 1 ? plural(to.length + cc.length, 'recipient', 'recipients') : null
  return { what: `Email ${who ?? 'someone'}`, reach, undo: UNDO.email }
}

/** A connector call: a known shape first, then the honest generic line. */
function mcpImpact(a: ImpactInput, facts: ImpactFacts): Omit<Impact, 'as'> {
  const kind = a.kind ?? kindOfTool(a.tool)
  const args = a.args ?? {}
  const known = slackImpact(a.tool, args, facts) ?? githubMcpImpact(a.tool, args, facts, a.link) ?? mailImpact(a.tool, args, kind) ?? ticketImpact(a.tool, args, kind)
  if (known) return known
  return { what: `Sends through ${serverName(a.tool)}`, reach: null, undo: null }
}

// ── Bash: gh and git ───────────────────────────────────────────────────────

/** A gh command's flags and positionals, by the flags that take a value. */
function ghArgs(words: string[], valueFlags: Set<string>): { pos: string[]; flags: Map<string, string[]>; bools: Set<string> } {
  const pos: string[] = []
  const flags = new Map<string, string[]>()
  const bools = new Set<string>()
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.startsWith('--') && w.includes('=')) {
      const k = w.slice(0, w.indexOf('='))
      flags.set(k, [...(flags.get(k) ?? []), w.slice(w.indexOf('=') + 1)])
    } else if (w.startsWith('-') && w.length > 1) {
      if (valueFlags.has(w) && i + 1 < words.length) {
        flags.set(w, [...(flags.get(w) ?? []), words[++i]])
      } else bools.add(w)
    } else pos.push(w)
  }
  return { pos, flags, bools }
}
const flag = (f: Map<string, string[]>, ...names: string[]): string[] => names.flatMap((n) => f.get(n) ?? [])

/** Plain text a shell decides at run time (`$X`, a backtick) is shown as unknown, never as a value. */
const shellKnows = (s: string) => /[$`]/.test(s)
const literal = (s: string | undefined | null): string | null => (s && !shellKnows(s) ? s : null)

const GH_VALUE = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-B', '--base', '-H', '--head', '-r', '--reviewer', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project', '-s', '--state', '-T', '--template', '--add-label', '--remove-label', '--add-reviewer', '--remove-reviewer', '--add-assignee', '--remove-assignee', '-c', '--comment', '--target', '-n', '--notes', '--subject', '--match-head-commit', '-X', '--method', '-f', '--field', '--raw-field', '--input', '--header', '--jq', '-q'])

function ghImpact(w: CommandPart, facts: ImpactFacts, link: string | null | undefined): (Omit<Impact, 'as'> & { kind: ActionKind }) | null {
  // gh [-R repo] <noun> <verb> …
  const at = w.findIndex((t, i) => i > 0 && !t.startsWith('-') && w[i - 1] !== '-R' && w[i - 1] !== '--repo')
  if (at < 0) return null
  const noun = w[at]
  const verb = w[at + 1] ?? ''
  const pre = ghArgs(w.slice(1, at), GH_VALUE)
  if (noun === 'api') {
    const rest = ghArgs(w.slice(at + 1), GH_VALUE)
    // gh api sends a GET unless it's given fields to send (then a POST) or a method.
    const fields = flag(rest.flags, '-f', '-F', '--field', '--raw-field', '--input').length > 0
    const method = (flag(rest.flags, '-X', '--method')[0] ?? (fields ? 'POST' : 'GET')).toUpperCase()
    const path = literal(rest.pos[0])
    return { kind: 'other', what: `Call the GitHub API${path ? ` · ${method} ${clip(path, 60)}` : ` · ${method}`}`, reach: null, undo: method === 'DELETE' ? UNDO.delete : null }
  }
  if (noun !== 'pr' && noun !== 'issue' && noun !== 'release') return null
  // `-r` is a reviewer on create and "request changes" on review.
  const vf = new Set(GH_VALUE)
  if (verb === 'review') {
    vf.delete('-r')
    vf.delete('-c')
    vf.delete('-a')
  }
  if (verb === 'merge') for (const f of ['-r', '-s', '-m', '-d']) vf.delete(f)
  const { pos, flags, bools } = ghArgs(w.slice(at + 2), vf)
  const url = fromUrl(pos[0])
  // Where a settled send landed: names the PR or issue a command left implicit (`gh pr comment` on this branch).
  const landed = fromUrl(link)
  const named = literal(flag(flags, '-R', '--repo')[0] ?? flag(pre.flags, '-R', '--repo')[0]) ?? url?.repo ?? null
  const repo = named ?? landed?.repo ?? str(facts.repo)
  const own = url?.n ?? (pos[0] && /^#?\d+$/.test(pos[0]) ? pos[0].replace('#', '') : null)
  const n = own ?? (!pos[0] && landed?.noun === noun && (!named || named === landed.repo) ? landed.n : null)
  const what = noun === 'pr' ? 'PR' : 'issue'
  const ref = refText(repo, n, what)
  const thing = ref ?? (noun === 'pr' ? 'this branch’s PR' : 'an issue')

  if (noun === 'release') {
    if (verb !== 'create') return null
    const tag = literal(pos[0])
    return { kind: 'release', what: `Publish ${tag ? `release ${tag}` : 'a release'}${repo ? ` in ${repo}` : ''}`, reach: null, undo: UNDO.release }
  }

  if (noun === 'pr' && verb === 'create') {
    const draft = bools.has('-d') || bools.has('--draft')
    const base = literal(flag(flags, '-B', '--base')[0])
    const values = flag(flags, '-r', '--reviewer')
    const people = values.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean)
    // The people the command names are known; a `$R` could be anyone, so then only the caller's fact counts.
    const reach = people.length && values.every((v) => literal(v)) ? `asks ${plural(people.length, 'reviewer', 'reviewers')}` : countText(facts.reviewers, 'reviewer', 'reviewers')
    return { kind: 'pr', what: `Open ${draft ? 'a draft PR' : 'a PR'}${repo ? ` in ${repo}` : ''}${base ? ` into ${base}` : ''}`, reach, undo: UNDO.pr }
  }
  if (verb === 'comment') return { kind: 'comment', what: `Comment on ${thing}`, reach: null, undo: UNDO.unsend }
  if (noun === 'pr' && verb === 'review') {
    const v = bools.has('-a') || bools.has('--approve') ? 'Approve' : bools.has('-r') || bools.has('--request-changes') ? 'Request changes on' : 'Review'
    return { kind: 'comment', what: `${v} ${thing}`, reach: null, undo: v === 'Review' ? UNDO.note : UNDO.review }
  }
  if (noun === 'pr' && verb === 'merge') {
    // --auto merges later, once checks pass; --disable-auto turns that off.
    if (bools.has('--disable-auto')) return { kind: 'update', what: `Turn off auto-merge for ${thing}`, reach: null, undo: UNDO.change }
    if (bools.has('--auto')) return { kind: 'merge', what: `Turn on auto-merge for ${thing}`, reach: null, undo: UNDO.auto }
    return { kind: 'merge', what: `Merge ${thing}`, reach: null, undo: UNDO.merge }
  }
  if (verb === 'close') return { kind: 'update', what: `Close ${thing}`, reach: null, undo: UNDO.reopen }
  if (verb === 'reopen') return { kind: 'update', what: `Reopen ${thing}`, reach: null, undo: UNDO.change }
  if (noun === 'pr' && verb === 'ready') {
    const undo = bools.has('--undo')
    return { kind: 'update', what: undo ? `Move ${thing} back to draft` : `Mark ${thing} ready for review`, reach: undo ? null : countText(facts.reviewers, 'reviewer', 'reviewers'), undo: UNDO.change }
  }
  if (verb === 'edit') return { kind: 'update', what: `Edit ${thing}`, reach: null, undo: UNDO.change }
  if (noun === 'issue' && verb === 'create') return { kind: 'ticket', what: `New issue in ${repo ?? 'this repo'}`, reach: null, undo: UNDO.ticket }
  return null
}

/** git's own flags that take the next word as their value: `git -C dir push`, `git -c k=v push`. */
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env'])

/** Where a git command's subcommand sits: the first word after git's own flags. -1 when there is none. */
function gitVerbAt(w: CommandPart): number {
  for (let i = 1; i < w.length; i++) {
    const t = w[i]
    if (GIT_VALUE.has(t)) {
      i++
      continue
    }
    if (t.startsWith('-')) continue
    return i
  }
  return -1
}

/** A `git push`'s words: its flags, the remote and the refspecs, up to a redirection. */
function pushArgs(w: CommandPart): { flags: string[]; remote: string | null; specs: string[] } {
  const at = gitVerbAt(w)
  const VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
  const flags: string[] = []
  const pos: string[] = []
  for (let i = at + 1; i < w.length; i++) {
    const t = w[i]
    if (/^[0-9]*[<>]/.test(t)) break
    if (t.startsWith('-')) {
      flags.push(t)
      if (VALUE.has(t)) i++
      continue
    }
    pos.push(t)
  }
  return { flags, remote: pos[0] === undefined ? null : literal(pos[0]), specs: pos.slice(1) }
}

/** A short-flag cluster (`-fu`) or a long flag, by name. */
const hasFlag = (flags: string[], short: string | null, ...long: string[]) =>
  flags.some((t) => long.some((l) => t === l || t.startsWith(`${l}=`)) || (!!short && /^-[a-zA-Z0-9]+$/.test(t) && t.slice(1).includes(short)))

/** The branch a refspec lands on, as plain words, or null when only the shell knows it. */
function specBranch(spec: string, current: string | null): string | null {
  if (/^\+?(?:HEAD|@)$/.test(spec)) return current
  const dst = spec.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '')
  if (/git branch --show-current|rev-parse --abbrev-ref/.test(dst)) return current
  return literal(dst)
}

const listOf = (names: string[]): string => clip(names.join(', '), 60)

/** A push's undo: a new branch can just be deleted; one already there needs a force-push; unknown says both. */
const pushUndo = (facts: ImpactFacts, branches: number): string =>
  branches !== 1 || facts.newBranch === undefined ? UNDO.push : facts.newBranch ? UNDO.pushNew : UNDO.pushOld

/** A real `git push`, not a dry run: the subcommand is `push` and its own flags don't say `-n`/`--dry-run`. */
function isPush(w: CommandPart): boolean {
  if (w[0] !== 'git') return false
  const at = gitVerbAt(w)
  return at > 0 && w[at] === 'push' && !hasFlag(pushArgs(w).flags, 'n', '--dry-run')
}

function gitPushImpact(part: CommandPart, facts: ImpactFacts, groupKey: string | null | undefined): Omit<Impact, 'as'> & { kind: ActionKind } {
  const w = unwrap(part)
  const { flags, remote, specs } = pushArgs(w)
  const to = remote ? ` to ${remote}` : ''
  const on = remote ? ` on ${remote}` : ''
  const fromKey = groupKey?.startsWith('push:') ? groupKey.split(':').slice(2).join(':') : ''
  const current = str(facts.currentBranch) ?? (fromKey && fromKey !== '?' ? fromKey : null)
  const isDefault = (b: string | null) => !!b && !!facts.defaultBranch && b === facts.defaultBranch
  const done = (what: string, branches: Array<string | null>, undo: string) =>
    ({ kind: 'push' as const, what, reach: branches.some(isDefault) ? 'the default branch' : null, undo })

  // Whole-remote pushes first: they reach past any one branch.
  if (hasFlag(flags, null, '--mirror')) return { kind: 'push', what: `Mirror every branch and tag${to}`, reach: null, undo: UNDO.mirror }
  const prune = hasFlag(flags, null, '--prune')
  if (hasFlag(flags, null, '--all', '--branches')) return { kind: 'push', what: `Push all branches${to}`, reach: null, undo: prune ? UNDO.prune : pushUndo(facts, 0) }
  const tags = hasFlag(flags, null, '--tags')

  // `--delete x` and `:x` both delete the remote branch.
  const del = hasFlag(flags, 'd', '--delete')
  const deleted = del ? specs : specs.filter((s) => s.startsWith(':') && s.length > 1)
  const pushed = del ? [] : specs.filter((s) => !deleted.includes(s))
  if (del || deleted.length) {
    const names = deleted.map((s) => specBranch(s.replace(/^:/, ''), null))
    const known = names.length > 0 && names.every((n): n is string => !!n)
    const gone = known ? `remote branch${names.length > 1 ? 'es' : ''} ${listOf(names as string[])}` : 'a remote branch'
    const also = pushed.length ? ` and push ${listOf(pushed.map((s) => specBranch(s, current) ?? 'a branch'))}` : ''
    return done(`Delete ${gone}${also}${on}`, names, UNDO.delete)
  }

  const force = flags.some((t) => t.startsWith('--force') || hasFlag([t], 'f')) || specs.some((s) => s.startsWith('+'))
  const verb = force ? 'Force-push' : 'Push'
  // A command run per input (`xargs git push`) pushes whatever it's fed.
  const xargs = wrappersOf(part).includes('xargs')
  const branches = xargs ? [null] : specs.length ? specs.map((s) => specBranch(s, current)) : [current]
  const undo = prune ? UNDO.prune : force ? UNDO.force : tags ? UNDO.tags : pushUndo(facts, xargs ? 0 : branches.length)
  if (tags && !specs.length) return { kind: 'push', what: `${verb} all tags${to}`, reach: null, undo }
  const named = branches.every((b): b is string => !!b) ? listOf(branches as string[]) : branches.length > 1 ? 'several branches' : 'a branch'
  return done(`${verb} ${named}${tags ? ' and all tags' : ''}${to}`, branches, undo)
}

/** The order a command that does several sends is read by: the headline wins (sort.ts KIND_RANK). */
const RANK: ActionKind[] = ['pr', 'ticket', 'comment', 'merge', 'release', 'post', 'message', 'email', 'update', 'push', 'other']

function bashImpact(a: ImpactInput, facts: ImpactFacts): Omit<Impact, 'as'> {
  // Raw, newlines kept: they separate commands. Only the text shown is collapsed (clip).
  const cmd = typeof a.args?.command === 'string' ? a.args.command : ''
  const hits: Array<Omit<Impact, 'as'> & { kind: ActionKind }> = []
  for (const part of splitCommand(cmd)) {
    const w = unwrap(part)
    if (w[0] === 'gh') {
      const g = ghImpact(w, facts, a.link)
      if (g) hits.push(g)
    } else if (isPush(w)) {
      hits.push(gitPushImpact(part, facts, a.groupKey))
    }
  }
  if (hits.length) {
    // The record's own kind wins when it names one of these; else the headline.
    const own = a.kind ? hits.find((h) => h.kind === a.kind) : undefined
    const lead = own ?? [...hits].sort((x, y) => RANK.indexOf(x.kind) - RANK.indexOf(y.kind))[0]
    const extra = hits.length - 1
    return { what: lead.what, reach: [lead.reach, extra > 0 ? `+${plural(extra, 'more send', 'more sends')}` : null].filter(Boolean).join(SEP) || null, undo: lead.undo }
  }
  // A command we can't read: say what runs, claim nothing about where it goes.
  const first = splitCommand(cmd).map(unwrap).find((w) => w.length) ?? []
  return { what: first.length ? `Run \`${clip(first.slice(0, 3).join(' '), 40)}\`` : 'Run a shell command', reach: null, undo: null }
}

/** The line's parts. impactLine joins them; a UI may set them apart. */
export function impactOf(action: ImpactInput, facts: ImpactFacts = {}): Impact {
  const as = asOf(facts)
  if (action.tool === 'Bash') return { ...bashImpact(action, facts), as }
  if (action.tool.startsWith('mcp__')) return { ...mcpImpact(action, facts), as }
  return { what: `Runs ${action.tool}`, reach: null, as, undo: null }
}
