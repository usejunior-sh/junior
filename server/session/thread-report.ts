/**
 * Up from a thread (.docs/redesign-b2-plan.md): when a chat started from a DM
 * (Junior's own, or an agent's) finishes a turn or blocks on the user, the DM
 * gets one notice line saying so: who, which thread, and the first sentence of
 * the reply. The notice is shown, never fed to the model. Then the DM gets a
 * real turn too (server/session/thread-wake.ts), so it can tell the user in one
 * line or stay quiet; reports that arrive while it is mid-turn wait for it.
 *
 * The same sentence goes in Junior's work log (server/worklog-ops.ts), one
 * entry per thread, so a later chat knows what got done without re-reading it.
 */
import { blockedText } from '../../core/junior/thread-wake.js'
import { threadReportLine, threadReportSentence } from '../../core/junior/threads.js'
import type { StoredSession } from '../../core/store/types.js'
import { chatAgentNamed } from '../chat-agents.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { sessionNotice } from '../team-run/state.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { noteWorkOp } from '../worklog-ops.js'
import { queueThreadReport } from './thread-wake.js'

export async function reportThreadTurn(rt: WorkspaceRuntime, row: StoredSession, said: string): Promise<void> {
  const parent = row.startedBy ? rt.rows.get(row.startedBy) : undefined
  if (!parent || parent.kind !== 'dm') return
  const agent = await chatAgentNamed(rt, row.agent)
  const who = agent?.label ?? rt.persona.name
  await sessionNotice(rt, parent.id, threadReportLine(who, row.title, said))
  queueThreadReport(rt, parent.id, { threadId: row.id, title: row.title, who, state: 'done', text: said, at: Date.now() })
  // Junior's own chat only: an agent's DM starting a thread isn't Junior's work.
  if (parent.agent) return
  await noteWorkOp(rt, {
    sessionId: row.id,
    title: row.title,
    ...(agent ? { agent: agent.label } : {}),
    said: threadReportSentence(said),
    at: Date.now(),
  }).catch((err) => log('warn', 'worklog', `could not note a thread's report: ${errText(err)}`, { sessionId: row.id }))
}

/** A thread started from a DM now waits on the user (a permission prompt or a question): the DM hears, once per wait. */
export async function reportThreadBlocked(rt: WorkspaceRuntime, row: StoredSession, toolName: string, input: Record<string, unknown>, title?: string, description?: string): Promise<void> {
  const parent = row.startedBy ? rt.rows.get(row.startedBy) : undefined
  if (!parent || parent.kind !== 'dm') return
  const who = (await chatAgentNamed(rt, row.agent))?.label ?? rt.persona.name
  await sessionNotice(rt, parent.id, `${who} is waiting on you in "${row.title}".`)
  queueThreadReport(rt, parent.id, { threadId: row.id, title: row.title, who, state: 'blocked', text: blockedText(toolName, input, title, description), at: Date.now() })
}
