/**
 * What Junior offers to do, built from what it can see: the first-open offers
 * (3–4 real items, each a starter), and the eight "What I can do" sentences
 * whose blanks are filled from real projects, items and refs. Every offer is a
 * starter: it opens a Junior chat with the first message written, waiting for
 * you to send it. Pure and browser-safe.
 */
import { shortRef } from './today.js'
import { sourceOf } from '../../shared/sources.js'
import { usd } from './watch-off.js'

/** What an offer reads of an open, ranked item. */
export type OfferItem = {
  id: string
  title: string
  url: string
  source: string
  kind: string
  repo: string
  author: string
  score: number
  ask?: string
  ciFailing?: boolean
  refs?: string[]
  createdAt: string
}

export type Offer = {
  title: string
  detail: string
  /** the source, as a word: "GitHub", "Slack", "Linear" */
  because: string
  /** the starter's first message */
  say: string
  /** a "New job:" chat rather than a plain one */
  intent?: 'job'
}

/** The source, as an offer's "because": "GitHub", "The web", "Your to-do", "Sentry". */
export const sourceWord = (s: string) => {
  const from = sourceOf(s).from
  return from.charAt(0).toUpperCase() + from.slice(1)
}

function waited(createdAt: string, now: number): string {
  const d = Math.floor((now - (Date.parse(createdAt) || now)) / 86_400_000)
  return d <= 0 ? 'today' : d === 1 ? 'a day' : `${d} days`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** How an offer names an item: its ref ("#479", "NOV-123"), or a to-do's own words, quoted. */
export function offerRef(i: Pick<OfferItem, 'id' | 'source' | 'repo' | 'url' | 'refs' | 'title'>): string {
  return sourceOf(i.source).yours ? `“${clip(i.title.replace(/[.!?]+$/, ''), 40)}”` : shortRef(i)
}

/** One offer for one item, by what it asks of you. */
export function offerFor(i: OfferItem, now: number): Offer {
  const ref = offerRef(i)
  const src = sourceOf(i.source)
  const because = sourceWord(i.source)
  if (i.ciFailing || i.kind === 'own-pr-conflicting') {
    const what = i.ciFailing ? 'the red check' : 'the merge conflicts'
    return {
      title: `Fix ${what} on ${ref}`,
      detail: `${clip(i.title, 60)}. I fix it in a worktree; the push waits for you.`,
      because,
      say: `Fix ${what} on ${ref} (${i.url}) in a worktree. Show me the diff; the push waits for my OK.`,
    }
  }
  if (i.ask === 'review') {
    const who = i.author ? `${i.author}'s ` : ''
    return {
      title: `First-pass review of ${who}${ref}`,
      detail: `Waiting ${waited(i.createdAt, now)}. I draft the comments; you edit and send.`,
      because,
      say: `Do a first-pass review of ${who}${ref} (${i.url}) and draft comments for me to edit. Nothing gets posted until I send it.`,
    }
  }
  if (i.ask === 'reply') {
    // Every source reads the same: Junior drafts, and nothing goes out until you send it. A chat holds
    // an outbound post (a gh comment, a Slack reply) on an approval card, so this stays true everywhere.
    const to = i.author ? ` to ${i.author}` : ''
    return {
      title: `Draft a reply${to} on ${ref}`,
      detail: `${clip(i.title, 60)}. I draft it; nothing is posted until you send it.`,
      because,
      say: `Draft a reply${to} on ${ref} (${i.url}) for me to edit. Nothing gets posted until I send it.`,
    }
  }
  // A to-do is named by its own words, in full in the message, so Junior can find it; anything else
  // gets its title and link alongside the ref.
  const mine = src.yours
  const about = mine ? '' : ` (${i.title}${i.url ? `, ${i.url}` : ''})`
  const said = mine ? `my to-do “${i.title}”` : ref
  if (i.ask === 'do' || i.ask === 'decide') {
    return {
      title: `Take ${ref} end to end`,
      detail: `${mine ? 'Your to-do' : clip(i.title, 60)}. You see my plan before I start.`,
      because,
      say: `Take ${said}${about}, plan it, and show me the plan before you start.`,
    }
  }
  return {
    title: `Read up on ${ref} and write you a note`,
    detail: `${mine ? 'Your to-do' : clip(i.title, 60)}. Kept as a note beside the work.`,
    because,
    say: `Read up on ${said}${about} and write me a note.`,
  }
}

/**
 * The first-open offers: the top items as starters (one per item, no repeats
 * of a ref), then a job offer for Slack mentions when Slack is connected.
 * Three or four in all.
 */
export function firstOffers(items: readonly OfferItem[], opts: { slack: boolean; now: number; max?: number }): Offer[] {
  const max = opts.max ?? 4
  const room = opts.slack ? max - 1 : max
  const out: Offer[] = []
  const seen = new Set<string>()
  for (const i of [...items].sort((a, b) => b.score - a.score)) {
    if (out.length >= room) break
    if (i.kind === 'digest' || i.ask === 'read') continue
    if (seen.has(i.id)) continue
    seen.add(i.id)
    out.push(offerFor(i, opts.now))
  }
  if (opts.slack) {
    out.push({
      title: "Catch Slack mentions you haven't answered",
      detail: 'Hourly. I draft replies; nothing is posted until you send it.',
      because: 'Slack',
      say: "Every hour, catch Slack mentions I haven't answered and draft replies for me to approve.",
      intent: 'job',
    })
  }
  return out
}

// What I can do: eight sentences, blanks filled from this Mac

/** The data the blanks are filled from. */
export type CanDoFill = {
  projects: string[]
  /** "the red check on #482", "issue #455" */
  fixes: string[]
  /** refs worth taking end to end: "NOV-123", "#455" */
  takes: string[]
  /** "a reply to Priya on #api", "my review of #479" */
  drafts: string[]
  /** refs worth reading up on */
  reads: string[]
  /** things to put on today's plan: refs or short titles */
  plans: string[]
  /** repos with review traffic: "acme/api" */
  repos: string[]
  slack: boolean
}

/** Build the fill from the open inbox and the projects. */
export function canDoFill(items: readonly OfferItem[], projects: readonly string[], slack: boolean): CanDoFill {
  const ranked = [...items].filter((i) => i.kind !== 'digest').sort((a, b) => b.score - a.score)
  const uniq = (xs: string[], n = 3) => [...new Set(xs.filter(Boolean))].slice(0, n)
  const ref = (i: OfferItem) => offerRef(i)
  return {
    projects: uniq([...projects], 4),
    fixes: uniq(
      ranked
        .filter((i) => i.ciFailing || i.kind === 'own-pr-conflicting' || i.ask === 'do')
        .map((i) => (i.ciFailing ? `the red check on ${ref(i)}` : i.kind === 'own-pr-conflicting' ? `the conflicts on ${ref(i)}` : `issue ${ref(i)}`)),
    ),
    takes: uniq(ranked.filter((i) => i.ask === 'do' || i.ask === 'decide' || sourceOf(i.source).shape === 'ticket').map(ref)),
    drafts: uniq(
      ranked
        .filter((i) => i.ask === 'reply' || i.ask === 'review')
        .map((i) => (i.ask === 'review' ? `my review of ${ref(i)}` : `a reply${i.author ? ` to ${i.author}` : ''} on ${ref(i)}`)),
    ),
    reads: uniq(ranked.map(ref)),
    plans: uniq(ranked.map((i) => (sourceOf(i.source).yours ? clip(i.title.replace(/[.!?]+$/, ''), 40).toLowerCase() : ref(i)))),
    repos: uniq(ranked.filter((i) => sourceOf(i.source).shape === 'pr' && i.repo).map((i) => i.repo), 2),
    slack,
  }
}

/** A blank's options; the first is shown until clicked. */
export type Blank = { options: string[] }
export type CanDoPart = string | Blank

export type CanDoCard = {
  id: string
  head: string
  parts: CanDoPart[]
  /** what Start does, in a line */
  note: string
  intent?: 'job'
}

const pick = (real: string[], fallback: string[]) => {
  const out = [...new Set([...real, ...fallback])]
  return out.slice(0, Math.max(3, Math.min(real.length + 1, 4)))
}

/** The eight sentences, filled. */
export function canDoCards(f: CanDoFill): CanDoCard[] {
  const projects = f.projects.length ? f.projects : ['this project']
  const repoAsks = [...f.repos.map((r) => `review requests on ${r}`), 'my open PRs', ...(f.slack ? ['my Slack mentions'] : [])]
  return [
    {
      id: 'fix',
      head: 'Fix it now',
      parts: ['Fix ', { options: pick(f.fixes, ['the failing test', 'the bug I describe']) }, ' in ', { options: projects }, ', and ', { options: ['show me the diff first', 'commit when tests pass', 'open a PR for me to approve'] }, '.'],
      note: 'One session, in its own worktree',
    },
    {
      id: 'take',
      head: 'Take it all the way',
      parts: ['Take ', { options: pick(f.takes, ['the next ticket']) }, ' to ', { options: ['a merged PR', 'a PR ready for review', 'QA'] }, ', and ', { options: ['show me the plan first', 'check in after each step', 'bring in a reviewer'] }, '.'],
      note: "I plan, you approve, I keep going until it's done",
    },
    {
      id: 'watch',
      head: 'Keep an eye on something',
      parts: ['Every ', { options: ['weekday at 9', 'hour', 'Monday morning'] }, ', check ', { options: [...new Set(repoAsks)] }, ' for ', { options: ['unanswered review comments', 'red CI', 'anything waiting on me'] }, '.'],
      note: 'A job, off until you turn it on',
      intent: 'job',
    },
    {
      id: 'plan',
      head: 'Plan the day',
      parts: ['Put ', { options: pick(f.plans, ['update the pricing page', 'the onboarding copy']) }, " on today's plan for ", { options: ['me', 'you'] }, '.'],
      note: 'Every session that day can see the plan',
    },
    {
      id: 'draft',
      head: 'Draft it for me',
      parts: ['Draft ', { options: pick(f.drafts, ['a status update for the team']) }, ', and ', { options: ['let me edit it before it goes', 'keep it under three lines'] }, '.'],
      note: 'Nothing is posted until you send it',
    },
    {
      id: 'read',
      head: 'Read up first',
      parts: ['Read up on ', { options: pick(f.reads, ['the latest issue']) }, ' and write me a note.'],
      note: 'Kept as a note beside the work',
    },
    {
      id: 'browser',
      head: 'Check it in a browser',
      parts: ['Open the ', { options: projects }, ' app at ', { options: ['390px', '1280px'] }, ' and check ', { options: ['the home page', 'sign-in', 'the settings page'] }, ' for ', { options: ['overflow', 'console errors', 'contrast in light mode'] }, '.'],
      note: 'Screenshots in the browser pane',
    },
    {
      id: 'routine',
      head: 'Teach me a routine',
      parts: ['Make a ', { options: ['skill', 'subagent'] }, ' that ', { options: ['drafts release notes from commits', 'reviews my diffs for missing tests', 'writes the PR description'] }, '.'],
      note: 'Usable in every session at once',
    },
  ]
}

/** The sentence with each blank at its picked option (index wraps). */
export function sentenceOf(card: CanDoCard, picks: readonly number[]): string {
  let b = 0
  return card.parts
    .map((p) => {
      if (typeof p === 'string') return p
      const i = picks[b++] ?? 0
      return p.options[((i % p.options.length) + p.options.length) % p.options.length] ?? ''
    })
    .join('')
}

/** A shortcut under the Junior page's box: a short label, and the message it writes into the box. */
export type TryShortcut = { label: string; say: string }

/**
 * Shortcuts from your real items, for the Junior page's starters: fix what's
 * red, review what waits on you, take a ticket. Jobs and the day's plan have
 * starters of their own; "More…" opens all eight cards.
 */
export function tryShortcuts(f: CanDoFill): TryShortcut[] {
  const cards = canDoCards(f)
  const say = (id: string) => sentenceOf(cards.find((c) => c.id === id)!, [])
  // a label reads as a name, not a quote: "Fix Add test", "Review #1296"
  const bare = (s: string) => clip(s.replace(/^(?:the red check on|the conflicts on|issue) /, '').replace(/[“”]/g, ''), 22)
  const out: TryShortcut[] = []
  const fix = f.fixes[0]
  if (fix) out.push({ label: `Fix ${bare(fix)}`, say: say('fix') })
  const review = f.drafts.find((d) => d.startsWith('my review of '))?.slice('my review of '.length)
  if (review) out.push({ label: `Review ${bare(review)}`, say: `Do a first-pass review of ${review} and draft comments for me to edit.` })
  // the same item twice ("Fix Add test", "Take Add test") is one shortcut
  const take = f.takes[0]
  if (take && !fix?.includes(take)) out.push({ label: `Take ${bare(take)}`, say: say('take') })
  return out
}

// First run: what Junior offers on day one, for every source it can see

/** What firstRunOffers reads of one probed MCP server (a Connector from GET /api/connectors). */
export type FirstRunConnector = {
  /** display name, "claude.ai " already stripped: "Sentry", "PagerDuty" */
  name: string
  /** the server name grants key on: "claude.ai Sentry" */
  server: string
  /** only "connected" ones get an offer */
  status: string
  /** `openWorld: false` on every tool = it stays on this Mac (a browser, an editor): not a source */
  tools?: ReadonlyArray<{ openWorld?: boolean }>
}

/** What firstRunOffers reads of one suggested project (a ProjectSuggestion from core/junior/project-rank.ts). */
export type FirstRunProject = { path: string; name: string; repo: string; why: string }

/** Everything Junior has detected on this Mac. The offers depend on this and nothing else. */
export type FirstRunState = {
  /** who `gh` is signed in as; null = not signed in, so no PR watch can run */
  ghLogin: string | null
  /** what the connector probe found */
  connectors: readonly FirstRunConnector[]
  /** suggested projects, best first (rankProjects drops the ones already added) */
  suggestions: readonly FirstRunProject[]
  /** the two PR watches' switches (Settings → Automations) */
  watches: { babysit: boolean; review: boolean }
  /** the spend limits the watch offers name (BabysitSettings.budget) */
  caps: { perDayUsd: number; perReviewUsd: number }
  /** the workspace's jobs: whether each is on, and the MCP servers it reads */
  jobs: ReadonlyArray<{ enabled: boolean; servers: readonly string[] }>
}

/** A job an offer would set up: the seeded library's file to turn on, or a starter to draft in a job chat. */
export type JobStarter = {
  /** the template's id: a seeded library file ("slack"), a known starter ("sentry"), or "generic" */
  id: string
  /** a seeded job file in jobs/ to turn on, when the template is one */
  library?: string
  title: string
  /** cron, as a job file takes it */
  schedule: string
  /** what the job looks for, as the job file's body would say it */
  instruction: string
}

type OfferBase = {
  /** stable per offer: "projects", "babysit", "review", "job:<server>" */
  id: string
  /** what Junior offers, in one line of 15 words or fewer */
  line: string
  /** pre-ticked: the suggested answer */
  default: boolean
}

export type FirstRunOffer =
  | (OfferBase & { kind: 'projects'; projects: Array<FirstRunProject & { default: boolean }> })
  | (OfferBase & { kind: 'watch'; watch: 'babysit' | 'review'; capText: string })
  | (OfferBase & {
      kind: 'job'
      server: string
      /** the source's name, as a chip: "Sentry" */
      name: string
      template: JobStarter
      /** the first message of the "New job:" chat that drafts it (saved off) */
      say: string
    })

/** Suggested projects pre-ticked on day one. */
export const FIRST_RUN_PROJECTS_TICKED = 3

/** Junior's own MCP servers: never offered as a source. */
const OWN_SERVERS = new Set(['junior', 'junior-dev', 'browser', 'team', 'triage', 'triage-dev'])

/** A known source's starter: matched on the connector's name, pre-ticked. */
type KnownStarter = { match: RegExp; id: string; library?: string; title: string; schedule: string; line: string; instruction: string; when: string }

const WORKDAY_15 = '*/15 8-18 * * 1-5'
const WORKDAY_HOURLY = '0 8-18 * * 1-5'
const WORKDAY_9 = '0 9 * * 1-5'

/**
 * The starters Junior knows by source. Slack's is the seeded library's job
 * (server/jobs/ops.ts SLACK_TEMPLATE, file `jobs/slack.md`); the rest are drafted
 * in a job chat and saved off, like any new job.
 */
const KNOWN_STARTERS: readonly KnownStarter[] = [
  {
    match: /^slack$/i,
    id: 'slack',
    library: 'slack',
    title: 'Slack',
    schedule: WORKDAY_15,
    when: 'every 15 minutes in working hours',
    line: 'Catch Slack questions you haven’t answered. Replies wait for your OK.',
    instruction: 'Find the Slack messages that need me: questions I have not answered, and mentions. One item per thread.',
  },
  {
    match: /^linear$/i,
    id: 'linear',
    title: 'Linear',
    schedule: WORKDAY_HOURLY,
    when: 'every hour in working hours',
    line: 'Bring Linear issues assigned to you into one list.',
    instruction: 'Find Linear issues assigned to me that changed since the last run, and new comments that ask me something. One item per issue.',
  },
  {
    match: /^(jira|atlassian)/i,
    id: 'jira',
    title: 'Jira',
    schedule: WORKDAY_HOURLY,
    when: 'every hour in working hours',
    line: 'Bring Jira issues assigned to you into one list.',
    instruction: 'Find Jira issues assigned to me that changed since the last run, and new comments that ask me something. One item per issue.',
  },
  {
    match: /^pager\s*duty$/i,
    id: 'pagerduty',
    title: 'PagerDuty',
    schedule: WORKDAY_15,
    when: 'every 15 minutes in working hours',
    line: 'Put PagerDuty incidents on you at the top of your list.',
    instruction: 'Find open PagerDuty incidents assigned to me or my escalation policy. One item per incident, with its service and urgency.',
  },
  {
    match: /^sentry$/i,
    id: 'sentry',
    title: 'Sentry',
    schedule: WORKDAY_9,
    when: 'every weekday at 9',
    line: 'Flag new Sentry errors in your projects each morning.',
    instruction: 'Find Sentry issues first seen since the last run, or regressed, in the projects I work on. One item per issue, busiest first.',
  },
  {
    match: /^rollbar$/i,
    id: 'rollbar',
    title: 'Rollbar',
    schedule: WORKDAY_9,
    when: 'every weekday at 9',
    line: 'Flag new Rollbar errors in your projects each morning.',
    instruction: 'Find Rollbar items first seen since the last run, or reactivated, in the projects I work on. One item per error.',
  },
  {
    match: /^notion$/i,
    id: 'notion',
    title: 'Notion',
    schedule: '0 9,14 * * 1-5',
    when: 'at 9 and 2 on weekdays',
    line: 'Catch Notion comments and mentions waiting on you.',
    instruction: 'Find Notion comments and mentions that ask me something I have not answered. One item per page.',
  },
  {
    match: /^gmail$/i,
    id: 'gmail',
    title: 'Gmail',
    schedule: WORKDAY_HOURLY,
    when: 'every hour in working hours',
    line: 'Catch email that asks something of you. Replies wait for your OK.',
    instruction: 'Find emails from people (not newsletters or alerts) that ask me something I have not answered. One item per thread.',
  },
]

/** Words in a line, as the 15-word rule counts them. */
export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length

/** A source's name, at most three words, so the generic line stays short. */
const shortName = (name: string): string => name.split(/\s+/).filter(Boolean).slice(0, 3).join(' ')

/** The starter for one connector: a known one by name, else the generic "watch this source". */
export function starterFor(name: string): { template: JobStarter; line: string; known: boolean; when: string } {
  const known = KNOWN_STARTERS.find((k) => k.match.test(name.trim()))
  if (known) {
    const { match: _m, line, when, ...template } = known
    return { template, line, known: true, when }
  }
  const n = shortName(name)
  return {
    template: {
      id: 'generic',
      title: n,
      schedule: WORKDAY_9,
      instruction: `Find anything in ${n} that waits on me or changed for me since the last run. One item per thing, with a link.`,
    },
    line: `Watch ${n} for anything that needs you.`,
    known: false,
    when: 'every weekday at 9',
  }
}

/** Whether a connector is a source worth a job: connected, not Junior's own, not local-only. */
function isSource(c: FirstRunConnector, ghLogin: string | null): boolean {
  if (c.status !== 'connected') return false
  if (OWN_SERVERS.has(c.server.toLowerCase()) || OWN_SERVERS.has(c.name.toLowerCase())) return false
  // gh is GitHub's built-in scanner; a GitHub MCP server is a source only when gh isn't signed in
  if (ghLogin && /^github$/i.test(c.name.trim())) return false
  const tools = c.tools ?? []
  if (tools.length && tools.every((t) => t.openWorld === false)) return false
  return true
}

/**
 * The first message's offers, from what Junior detected and nothing else:
 * add these projects; turn on babysitting with its budget; turn on review
 * first pass; then one job per connected source no job reads yet (known
 * sources first, in KNOWN_STARTERS order, then the rest by name). Each has a
 * pre-ticked default: projects (top three), the watches, and known sources
 * on; a source Junior has no starter for off. Nothing here applies anything.
 */
export function firstRunOffers(state: FirstRunState): FirstRunOffer[] {
  const out: FirstRunOffer[] = []
  if (state.suggestions.length) {
    const projects = state.suggestions.map((p, i) => ({ ...p, default: i < FIRST_RUN_PROJECTS_TICKED }))
    const n = Math.min(state.suggestions.length, FIRST_RUN_PROJECTS_TICKED)
    out.push({
      kind: 'projects',
      id: 'projects',
      line: n === 1 ? 'Add the repo where you run Claude Code most.' : `Add the ${n} repos where you run Claude Code most.`,
      default: true,
      projects,
    })
  }
  // both watches read PRs through gh: without a login there's nothing to turn on
  if (state.ghLogin && !state.watches.babysit) {
    const cap = `Up to ${usd(state.caps.perDayUsd)} a day`
    out.push({ kind: 'watch', id: 'babysit', watch: 'babysit', line: `Babysit PRs you hand me: CI, retries, nits. ${cap}.`, default: true, capText: cap })
  }
  if (state.ghLogin && !state.watches.review) {
    const cap = `Up to ${usd(state.caps.perReviewUsd)} a review`
    out.push({ kind: 'watch', id: 'review', watch: 'review', line: `Draft first-pass reviews of PRs you hand me. ${cap}.`, default: true, capText: cap })
  }
  const covered = new Set(state.jobs.filter((j) => j.enabled).flatMap((j) => j.servers))
  const seen = new Set<string>()
  const jobs: Array<{ offer: FirstRunOffer; rank: number }> = []
  for (const c of state.connectors) {
    if (!isSource(c, state.ghLogin) || covered.has(c.server)) continue
    const key = c.name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const { template, line, known, when } = starterFor(c.name)
    const rank = known ? KNOWN_STARTERS.findIndex((k) => k.id === template.id) : KNOWN_STARTERS.length
    jobs.push({
      rank,
      offer: {
        kind: 'job',
        id: `job:${c.server}`,
        server: c.server,
        name: c.name,
        line,
        default: known,
        template,
        say: template.library
          ? `Turn on the ${template.title} job: ${when}, ${lowerFirst(template.instruction)}`
          : `New job: ${when}, check ${c.name} (${c.server}). ${template.instruction} Save it off so I can try a run first.`,
      },
    })
  }
  jobs.sort((a, b) => a.rank - b.rank || (a.offer.kind === 'job' && b.offer.kind === 'job' ? a.offer.name.localeCompare(b.offer.name) : 0))
  for (const j of jobs) out.push(j.offer)
  return out
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)
