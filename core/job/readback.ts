/**
 * What a drafted job may do, in plain words, built from its file
 * (job-readback-steps). The chat shows these rows under the `draft_job` call,
 * so what the user reads before a trial run is what the file grants, not what
 * the model says it grants.
 *
 * Sends are judged by `sortCall`, the rule the run's hold uses, by tool name
 * only (server hints aren't stored in the file). An unknown verb counts as a
 * send there, so it counts as one here: the words never promise less than the
 * gate enforces. That can over-count a send; it never under-counts.
 *
 * Pure and browser-safe.
 */
import { DEFAULT_RULES } from '../actions/rules.js'
import { kindOfTool, sortCall } from '../actions/sort.js'
import type { ActionKind } from '../actions/types.js'
import { describeCron } from './cron.js'
import { serverLabel, type JobToolGrant } from './tools.js'
import type { JobBrief, JobBrowser, JobOutput } from './types.js'
import { HELD_FOR_YOU, isQuiet, type Readback, type ReadbackLabel, type ReadbackRow } from './readback-text.js'

export * from './readback-text.js'

/** What the read-back needs of a job file (server/job-files.ts JobFileSpec). */
export type ReadbackSpec = {
  schedule: string
  tools: JobToolGrant[]
  output: JobOutput
  brief?: JobBrief
  browser?: JobBrowser
}

const KIND_NOUN: Record<ActionKind, string> = {
  message: 'messages',
  comment: 'comments',
  ticket: 'tickets',
  pr: 'pull requests',
  update: 'updates',
  email: 'emails',
  post: 'posts',
  merge: 'merges',
  push: 'pushes',
  release: 'releases',
  other: 'changes',
}

/** "a", "a and b", "a, b and c". */
function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('')
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/** True when a run's hold would stop this tool: the same sort a run's call goes through. */
export const isSendTool = (tool: string): boolean => sortCall(tool, {}, { rules: DEFAULT_RULES }) !== null

export function readbackOf(spec: ReadbackSpec, ctx: { file: string; projectName: string }): Readback {
  const reads: string[] = []
  const sends = new Map<string, ActionKind[]>()
  const add = (xs: string[], x: string) => {
    if (!xs.includes(x)) xs.push(x)
  }
  // built-ins first, in a fixed order, so the web and GitHub lead the Reads row
  const has = (id: string) => spec.tools.some((g) => g.source.kind === 'builtin' && g.source.id === id)
  if (has('web')) add(reads, 'the web')
  if (has('github')) add(reads, 'GitHub (read only)')
  const writes = has('files-write')
  for (const g of spec.tools) {
    if (g.source.kind !== 'mcp') continue
    const label = serverLabel(g.source.server)
    for (const tool of g.tools) {
      if (isSendTool(tool)) {
        const kinds = sends.get(label) ?? []
        if (!kinds.includes(kindOfTool(tool))) kinds.push(kindOfTool(tool))
        sends.set(label, kinds)
      } else {
        add(reads, label)
      }
    }
  }
  add(reads, `code in ${ctx.projectName}`)

  const sendsValue = sends.size
    ? `${[...sends].map(([label, kinds]) => `${label} ${andList(kinds.map((k) => KIND_NOUN[k]))}`).join(', ')}. ${HELD_FOR_YOU}`
    : 'none'
  const rows: Array<[ReadbackLabel, string]> = [
    ['Reads', reads.join(', ')],
    ['Writes', writes ? `files in ${ctx.projectName}` : 'nothing'],
    ['Sends', sendsValue],
  ]
  if (spec.browser) {
    const where = spec.browser.sites?.length ? `pages on ${andList(spec.browser.sites)}` : 'any page'
    rows.push(['Browser', `${where}, as ${spec.browser.profile}. The browser gate checks each step.`])
  }
  rows.push([
    'Files',
    spec.output === 'digest' ? 'one digest, updated each run' : spec.brief ? 'one item per match, each with a brief' : 'one item per match, in your inbox',
  ])
  rows.push(['Runs', `${describeCron(spec.schedule)}. Off until you turn it on.`])
  return {
    file: ctx.file,
    rows: rows.map(([label, value]): ReadbackRow => ({ label, value, ...(isQuiet(value) ? { quiet: true } : {}) })),
  }
}
