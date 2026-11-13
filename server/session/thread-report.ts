/**
 * Up from a thread (.docs/redesign-b2-plan.md): when a chat Junior started from
 * its own chat finishes a turn, Junior's chat gets one line saying so: who,
 * which thread, and the first sentence of the reply. A notice, never a message,
 * so it costs no turn and never reaches the model; the thread card above it
 * already shows the state, and read_session reads the rest when asked.
 *
 * The same sentence goes in Junior's work log (server/worklog-ops.ts), one
 * entry per thread, so a later chat knows what got done without re-reading it.
 */
import { threadReportLine, threadReportSentence } from '../../core/junior/threads.js'
import type { StoredSession } from '../../core/store/types.js'
import { chatAgentNamed } from '../chat-agents.js'
import { errText } from '../errors.js'
import { log } from '../log.js'
import { sessionNotice } from '../team-run/state.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import { noteWorkOp } from '../worklog-ops.js'

export async function reportThreadTurn(rt: WorkspaceRuntime, row: StoredSession, said: string): Promise<void> {
  const parent = row.startedBy ? rt.rows.get(row.startedBy) : undefined
  if (!parent || parent.kind !== 'dm') return
  const agent = await chatAgentNamed(rt, row.agent)
  await sessionNotice(rt, parent.id, threadReportLine(agent?.label ?? rt.persona.name, row.title, said))
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
