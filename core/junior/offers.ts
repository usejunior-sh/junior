/**
 * What Junior offers to do, built from what it can see: the first-open offers
 * (3–4 real items, each a starter), and the eight "What I can do" sentences
 * whose blanks are filled from real projects, items and refs. Every offer is a
 * starter: it opens a Junior chat with the first message written, waiting for
 * you to send it. Pure and browser-safe.
 */
import { shortRef } from './today.js'

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

const SOURCE_WORD: Record<string, string> = { github: 'GitHub', slack: 'Slack', linear: 'Linear', manual: 'Your to-do', job: 'A job', web: 'The web' }
export const sourceWord = (s: string) => SOURCE_WORD[s] ?? s

function waited(createdAt: string, now: number): string {
  const d = Math.floor((now - (Date.parse(createdAt) || now)) / 86_400_000)
  return d <= 0 ? 'today' : d === 1 ? 'a day' : `${d} days`
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** How an offer names an item: its ref ("#479", "NOV-123"), or a to-do's own words, quoted. */
export function offerRef(i: Pick<OfferItem, 'id' | 'source' | 'repo' | 'url' | 'refs' | 'title'>): string {
  return i.source === 'manual' ? `“${clip(i.title.replace(/[.!?]+$/, ''), 40)}”` : shortRef(i)
}

/** One offer for one item, by what it asks of you. */
export function offerFor(i: OfferItem, now: number): Offer {
  const ref = offerRef(i)
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
    const where = i.source === 'slack' ? ref : ref
    return {
      title: `Draft a reply${i.author ? ` to ${i.author}` : ''} on ${where}`,
      detail: `${clip(i.title, 60)}. I draft it; nothing is posted until you send it.`,
      because,
      say: `Draft a reply${i.author ? ` to ${i.author}` : ''} on ${where} (${i.url}) for me to edit. Nothing gets posted until I send it.`,
    }
  }
  // A to-do is named by its own words, in full in the message, so Junior can find it; anything else
  // gets its title and link alongside the ref.
  const mine = i.source === 'manual'
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
    takes: uniq(ranked.filter((i) => i.ask === 'do' || i.ask === 'decide' || i.source === 'linear').map(ref)),
    drafts: uniq(
      ranked
        .filter((i) => i.ask === 'reply' || i.ask === 'review')
        .map((i) => (i.ask === 'review' ? `my review of ${ref(i)}` : `a reply${i.author ? ` to ${i.author}` : ''} on ${ref(i)}`)),
    ),
    reads: uniq(ranked.map(ref)),
    plans: uniq(ranked.map((i) => (i.source === 'manual' ? clip(i.title.replace(/[.!?]+$/, ''), 40).toLowerCase() : ref(i)))),
    repos: uniq(ranked.filter((i) => i.source === 'github' && i.repo).map((i) => i.repo), 2),
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
