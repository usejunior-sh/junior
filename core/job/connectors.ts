/**
 * The job run prompt. The
 * tool fence lives in tools.ts / fence.ts; this file only tells the model how
 * to use what it was granted. Where to look inside a connector is the
 * instruction's job; the model finds channels, teams and labels itself.
 *
 * Runs are stateless: no cursor. The look-back window is the user's (named in
 * their instructions) or a default computed from the schedule.
 */
import { humanSpan } from './schedule.js'
import { MAX_WEB_FETCHES, grantLabel, runDeferredTools, serverLabel, type JobToolGrant } from './tools.js'
import type { JobOutput } from './types.js'
import { askGuide } from '../work/asks.js'
import { filingPrompt, type JobFiling } from './filing.js'

export { MAX_WEB_FETCHES } from './tools.js'

export const MAX_ROWS_PER_RUN = 15

const BUILTIN_HOW_TO = {
  github: 'GitHub: use the `gh` CLI, read verbs only (pr list/view/diff/checks, issue list/view, search, run list/view). One command per call: no pipes, `&&`, redirects or `$(...)`. The PR or issue URL identifies it.',
  web: `Web: search with WebSearch and read pages with WebFetch. WebFetch takes two parameters, url and prompt (what to extract from the page) — always pass both. Fetch at most ${MAX_WEB_FETCHES} pages per run; judge from search snippets first. Check the date on the page itself before trusting it. The page URL identifies a find.`,
  'files-write': 'Files: you may write and edit files inside the project folder only, e.g. notes this job keeps for itself.',
} as const

const SERVER_HOW_TO: Record<string, string> = {
  'claude.ai Slack': 'Slack: search and read channels, threads and DMs through the Slack tools. The permalink of the root message identifies a thread.',
  'claude.ai Linear': 'Linear: list and read issues, teams, projects and comments through the Linear tools. Find the team or label the instructions name by searching; never assume a key. The issue URL (or its key, e.g. PX-123) identifies an issue.',
}

/**
 * The browser paragraph: which profile the run is signed in as, where it may
 * go, and that it reads and never commits (the gate refuses those clicks anyway).
 */
export function browserHowTo(b: { profile: string; sites?: string[] }): string {
  const where = b.sites?.length
    ? `You may open only ${b.sites.join(', ')} (a *. name covers its subdomains), plus pages on this machine.`
    : 'You may open any site, plus pages on this machine.'
  return [
    `Browser: you have Junior's browser, signed in as the user's "${b.profile}" profile. Open a page with browser_open, read it with browser_snapshot (pass find to narrow a big page) or browser_extract, and wait for it with browser_wait. Its URL identifies a find.`,
    where,
    "You may type, scroll and follow links. You can't press Send, Submit, Save or anything else that changes something: the run refuses it. Record what you found with your write tool instead.",
    'Never sign in or type a password. If a page asks you to log in, stop and say the profile needs signing in (Settings → Browser).',
  ].join(' ')
}

function howTo(g: JobToolGrant): string {
  if (g.source.kind === 'builtin') return BUILTIN_HOW_TO[g.source.id]
  return (
    SERVER_HOW_TO[g.source.server] ??
    `${serverLabel(g.source.server)}: use its tools as their descriptions say. The link (URL) of what you find identifies it.`
  )
}

/**
 * The run prompt. Output contract is tool calls, not JSON: one upsert per
 * match, the server stamps identity and provenance (.docs/jobs-v2.md).
 */
export function composeRunPrompt(w: {
  instruction: string
  tools: JobToolGrant[]
  project: { name: string; path: string }
  output?: JobOutput
  /** default look-back when the instructions name none, from the schedule */
  lookbackMs: number
  /** now, ISO, the run has no other clock */
  nowIso: string
  /** legacy place hint from pre-connector jobs */
  scope?: string
  /** a catch-up run's lateness line (describeLateness) */
  lateness?: string
  /** skills the job names: the only ones the Skill tool will load */
  skills?: string[]
  /** subagents the job names: the only ones the Agent tool will start */
  agents?: string[]
  /** how it files: reason, labels, tiers */
  filing?: JobFiling
  /** the browser profile (its name) and sites, when the job names one */
  browser?: { profile: string; sites?: string[] }
}): string {
  const deferred = runDeferredTools(w.tools)
  const span = humanSpan(w.lookbackMs)
  const lines = [
    `You are a junior scanner running ONE job, read-only unless a tool below says otherwise. It is now ${w.nowIso}.`,
    w.lateness ?? '',
    `Time window: if the instructions name one, use it. Otherwise look at roughly the last ${span}. If the instructions ask for what is true now (open tasks, pending reviews) rather than what is new, ignore this window.`,
    deferred.length
      ? `Your tools are deferred: before anything else, call ToolSearch with "select:${deferred.join(',')}" to load their schemas, then use them. Never call a tool you have not loaded.`
      : '',
    `Integrations you may use: ${[...w.tools.map(grantLabel), ...(w.browser ? ['Browser'] : [])].join(', ')}.`,
    ...w.tools.map(howTo),
    w.browser ? browserHowTo(w.browser) : '',
    `Project: the folder ${w.project.path} (${w.project.name}) is your working directory and the only folder you may read. Read code with Read/Grep/Glob and git log/show/diff when the instructions need it.`,
    w.skills?.length ? `Skills you may load with the Skill tool, when the instructions call for them: ${w.skills.join(', ')}. No others.` : '',
    w.agents?.length
      ? `Subagents you may hand a piece of the work to with the Agent tool (subagent_type exactly as written): ${w.agents.join(', ')}. No others; they run under the same limits as you.`
      : '',
    w.scope ? `Look in ${w.scope} only.` : '',
    `Instructions:\n${w.instruction}`,
    `Judge each candidate on its title and first ~200 characters; open the full thread, issue, page or diff only when that is not enough to decide.`,
    ...(w.output === 'digest'
      ? [
          `Output: ONE digest. When you have looked at everything relevant, call the write_digest tool exactly once with:
- title: a short name for this edition (e.g. "AI news · 12 Sep")
- body: the whole digest as markdown — lead with the two or three things worth attention and why, then the rest as a tight list with links; say what window you covered
- refs: any GitHub PR/issue URLs or Linear keys you cite (omit if none)
Do not file individual items. If there is nothing new in the window, do not call write_digest — just finish with one line saying so.`,
          `write_digest is the ONLY junior write tool you may use. If you cannot access any of the integration tools at all, reply with exactly no-connector-tools and stop.`,
        ]
      : [
          `For EACH match, call the upsert_work_item tool exactly once with:
- url: the canonical link (Slack permalink, Linear issue URL or key, GitHub PR/issue URL, or the page URL)
- title: a one-line summary
- place: where it lives — "#channel", "@dm", the Linear team key, "owner/repo", or the site name
- from: the author or asker, when known
- lastActivity: ISO 8601 timestamp of the newest activity
- why: one line stating exactly what matched the instructions
- ask: what it asks of the user — pick exactly one:
${askGuide()}
  Pick review, reply or decide only when a person is waiting on the user. When unsure, pick read.
- due: only when the content states a deadline for the user ("by EOD", "before Friday's release", a ticket due date): that day as YYYY-MM-DD. Omit otherwise; never guess one
- refs: any other GitHub PR/issue URLs or Linear keys visible in the content (omit if none)
${filingPrompt(w.filing)}`,
          `The tool tells you when something is already filed. An "already filed and open" reply means the user has it: do not count it as new, move on to the next candidate.`,
          `Call upsert_work_item at most ${MAX_ROWS_PER_RUN} times. It is the ONLY junior write tool you may use. If nothing matches, do not call it — just finish with a one-line summary of what you looked at. If you cannot access any of the integration tools at all, reply with exactly no-connector-tools and stop.`,
        ]),
  ]
  return lines.filter(Boolean).join('\n\n')
}
