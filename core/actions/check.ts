/**
 * check_send: a dry run of the send policy (core/actions/policy.ts) for any
 * agent on this Mac. Cursor, Codex or a terminal Claude Code asks "would
 * this go out as the user?" before it acts, and gets the answer Junior's own
 * chats live by:
 *
 *   free      local work, a read, or a send the policy lets through (a push
 *             to your own branch, a draft PR, one an advance approval covers)
 *   held      it reaches a person, so it waits on a card for the user's OK
 *   destroys  it throws away work you can't get back, so it asks first
 *   refused   it would approve sends through Junior's own API: only the user
 *             does that, in the app
 *
 * Judged in the same order as a Claude chat's veto (server/session/
 * actions-hold.ts sessionVeto → holdIfAction): self-approval, destroys, the
 * shell's free sends, the sort, advance approvals. It never runs, sends or
 * queues anything; the caller stays the one who acts.
 *
 * The dry run can't see how a server was registered (core/actions/own.ts), so
 * no server counts as Junior's own here: every MCP call is sorted on its
 * merits, and an unsure answer leans to held. Pure and browser-safe.
 */
import { type AdvanceApproval, describeApproval, matchApproval } from '../approvals/approvals.js'
import { destructiveCommand } from './commands.js'
import { NO_OWN_SERVERS } from './own.js'
import { type BranchScope, chatBashVerdict, selfApproval } from './policy.js'
import type { ActionRules } from './rules.js'
import { leafOf, serverOf, sortCall, toolOverride, type SortedAction, type ToolHints, unsortedAction } from './sort.js'
import type { SendCheck } from './types.js'

export type { SendCheck, SendVerdict } from './types.js'
export { SEND_VERDICTS } from './types.js'

export type CheckContext = {
  /** the workspace's actions file */
  rules: ActionRules
  /** what an MCP server says about its tools, when a probe saw it */
  hints?: (toolName: string) => ToolHints | undefined
  /** where the shell stands; unknown = nulls, so `git push` with no branch named is held */
  scope: BranchScope
  /** the user's advance approvals, live and expired alike (matchApproval checks) */
  approvals: readonly AdvanceApproval[]
  now: number
}

const SORTED_BY: Record<SortedAction['why'], string> = {
  'bash pattern': 'matches',
  override: 'the actions file counts it:',
  annotation: 'its server marks it',
  'name verb': 'its name says',
  unknown: "Junior can't tell what it does, so it counts as a send",
}

function sortedBy(s: SortedAction): string {
  const lead = SORTED_BY[s.why]
  return s.whyDetail ? `${lead} ${s.whyDetail}` : lead
}

/** Why a held call waits, in one sentence the agent can repeat. */
function heldWhy(tool: string, s: SortedAction): string {
  const base = `It sends (${s.summary}), so it waits on a card for the user's OK.`
  if (tool === 'Bash' && s.kind === 'push') return `${base} Only a push to a branch that isn't the default one, named in the command, runs free.`
  if (tool === 'Bash' && s.kind === 'pr') return `${base} Only a draft PR (gh pr create --draft) runs free.`
  return base
}

/** Why an MCP call the sort let through is free. */
function freeMcpWhy(tool: string, ctx: CheckContext): string {
  if (toolOverride(ctx.rules, tool)?.verdict === 'off') return 'The actions file sets this tool aside: it is not a send.'
  const h = ctx.hints?.(tool)
  if (h?.readOnly === true) return `${serverOf(tool)} marks ${leafOf(tool)} read-only: nothing goes out.`
  if (h?.openWorld === false) return `${serverOf(tool)} says ${leafOf(tool)} stays inside its own system: nothing goes out.`
  return `${leafOf(tool)} reads: nothing goes out.`
}

/** The answer for a call that sorted as a send: covered by an advance approval, or held. */
function sendAnswer(tool: string, input: Record<string, unknown>, s: SortedAction, ctx: CheckContext): SendCheck {
  const facts = { kind: s.kind, summary: s.summary, sortedBy: sortedBy(s) }
  const rule = matchApproval(ctx.approvals, tool, input, {}, ctx.now)
  if (rule) {
    const approval = describeApproval(rule)
    return { verdict: 'free', why: `The user approved this in advance (${approval}), so it goes out now and Junior's log says which approval let it.`, ...facts, approval }
  }
  return { verdict: 'held', why: heldWhy(tool, s), ...facts }
}

/**
 * Would this call go out as the user? `tool` is the name an agent calls it
 * by (`Bash`, `Edit`, `mcp__<server>__<tool>`), `input` its arguments.
 */
export function checkSend(tool: string, input: Record<string, unknown>, ctx: CheckContext): SendCheck {
  const sort = (t: string, i: Record<string, unknown>): SortedAction | null => {
    try {
      return sortCall(t, i, { rules: ctx.rules, hints: ctx.hints?.(t), own: NO_OWN_SERVERS })
    } catch {
      // The hold fails closed: a call it can't sort is a send.
      return unsortedAction(t, i)
    }
  }

  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (!command.trim()) return { verdict: 'free', why: 'An empty command runs nothing.' }
    if (selfApproval(command)) return { verdict: 'refused', why: "It approves sends through Junior's own API. Only the user does that, in the app." }
    const destroys = destructiveCommand(command)
    if (destroys) return { verdict: 'destroys', why: `This command ${destroys}, so it needs the user's OK first.` }
    let v: ReturnType<typeof chatBashVerdict>
    try {
      v = chatBashVerdict(command, ctx.scope, (part) => sort('Bash', { command: part }))
    } catch {
      v = { verdict: 'hold' }
    }
    if (v.verdict === 'allow') {
      if (v.free === 'your branch') return { verdict: 'free', why: "A push to a branch that isn't the default one stays the user's: it runs free.", kind: 'push' }
      if (v.free === 'draft PR') return { verdict: 'free', why: 'A draft PR asks nobody to look yet: it runs free.', kind: 'pr' }
      return { verdict: 'free', why: 'Local work: nothing in this command leaves this Mac.' }
    }
    return sendAnswer(tool, input, sort('Bash', input) ?? unsortedAction(tool, input), ctx)
  }

  // Write, Edit, Read, NotebookEdit…: they touch this Mac at most.
  if (!tool.startsWith('mcp__')) return { verdict: 'free', why: `Local work: ${tool} touches this Mac at most, and nothing goes out.` }

  const s = sort(tool, input)
  if (!s) return { verdict: 'free', why: freeMcpWhy(tool, ctx) }
  return sendAnswer(tool, input, s, ctx)
}
