import { statSync } from 'node:fs'
import path from 'node:path'
import { checkSend, type SendCheck } from '../../core/actions/check.js'
import { type BranchScope, mayBeFree } from '../../core/actions/policy.js'
import { holdable, isArgsObject } from '../../core/actions/queue.js'
import type { ActionRules } from '../../core/actions/rules.js'
import type { AdvanceApproval } from '../../core/approvals/approvals.js'
import { currentBranch } from '../git.js'
import { defaultBranch } from '../worktrees.js'
import { WorkspaceRuntime } from '../workspace/runtime.js'
import { log } from '../log.js'
import { errText } from '../errors.js'
import { toolHints } from './actions-record.js'

// check_send (core/actions/check.ts): the send policy as a dry run, behind
// POST /api/actions/check and the in-process junior tool of the same name.
// It reads the actions file, the approvals list and, when asked about a push
// from a folder, that folder's branch. It writes nothing: no record, no held
// call, no approval use, no broadcast.

const UNKNOWN_SCOPE: BranchScope = { current: null, defaultBranch: null }
/** What a built-in local tool is judged with when the file is unreadable: it never reads them. */
const NO_RULES: ActionRules = { bash: [], action: [], notAction: [] }

/** A folder the caller named for its shell: absolute and real, or an error. */
function folderOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !path.isAbsolute(raw) || raw.length > 4096) throw new Error('cwd is an absolute folder path')
  let isDir = false
  try {
    isDir = statSync(raw).isDirectory()
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`no such folder: ${raw}`)
  return raw
}

/** The checked-out branch and the default one, read from git in that folder. Local reads only. */
async function scopeOf(cwd: string): Promise<BranchScope> {
  const [current, def] = await Promise.all([currentBranch(cwd), defaultBranch(cwd).catch(() => null)])
  return { current, defaultBranch: def }
}

/** `{ tool, input, cwd? }` → would it go out as the user? Read-only. */
export async function checkSendOp(rt: WorkspaceRuntime, raw: unknown): Promise<SendCheck> {
  const r = isArgsObject(raw) ? raw : {}
  const tool = typeof r.tool === 'string' ? r.tool.trim() : ''
  if (!tool || tool.length > 300) throw new Error('need the tool name, e.g. "Bash", "Edit" or "mcp__slack__send_message"')
  if (r.input !== undefined && !isArgsObject(r.input)) throw new Error('input is the call\'s arguments, a JSON object (for Bash: { "command": "…" })')
  const input = (r.input ?? {}) as Record<string, unknown>
  const cwd = folderOf(r.cwd)

  let rules: ActionRules
  try {
    rules = rt.actionsFile.current().rules
  } catch (err) {
    // Fail closed, like the hold: an unreadable actions file holds every call it would sort.
    log('warn', 'actions', `check_send could not read the actions file: ${errText(err)}`, { workspace: rt.meta.id })
    if (holdable(tool)) return { verdict: 'held', why: "Junior couldn't read its actions file, so it holds every shell command and connector call until that's fixed." }
    rules = NO_RULES
  }
  let approvals: AdvanceApproval[] = []
  try {
    approvals = await rt.store.approvals.list()
  } catch (err) {
    // No approvals read = none apply: the answer leans to held.
    log('warn', 'actions', `check_send could not read approvals: ${errText(err)}`, { workspace: rt.meta.id })
  }
  const command = tool === 'Bash' && typeof input.command === 'string' ? input.command : ''
  const scope = cwd && command && mayBeFree(command) ? await scopeOf(cwd) : UNKNOWN_SCOPE
  return checkSend(tool, input, { rules, hints: (t) => toolHints(rt, t), scope, approvals, now: Date.now() })
}
