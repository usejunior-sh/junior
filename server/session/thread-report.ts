/**
 * Up from a thread (.docs/redesign-b2-plan.md): when a chat Junior started from
 * its own chat finishes a turn, Junior's chat gets one line saying so: who,
 * which thread, and the first sentence of the reply. A notice, never a message,
 * so it costs no turn and never reaches the model; the thread card above it
 * already shows the state, and read_session reads the rest when asked.
 */
import { threadReportLine } from '../../core/junior/threads.js'
import type { StoredSession } from '../../core/store/types.js'
import { chatAgentNamed } from '../chat-agents.js'
import { sessionNotice } from '../team-run/state.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

export async function reportThreadTurn(rt: WorkspaceRuntime, row: StoredSession, said: string): Promise<void> {
  const parent = row.startedBy ? rt.rows.get(row.startedBy) : undefined
  if (!parent || parent.kind !== 'dm') return
  const agent = await chatAgentNamed(rt, row.agent)
  await sessionNotice(rt, parent.id, threadReportLine(agent?.label ?? rt.persona.name, row.title, said))
}
