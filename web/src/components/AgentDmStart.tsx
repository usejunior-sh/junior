/**
 * An agent's DM before its first message: its face, who it is, and the same
 * prompt box a new chat has, with the agent fixed. The first send makes the
 * DM (`create_session` with `dm`), and from then on the Agents page shows it
 * as a chat (core/junior/dms.ts).
 */
import type { CreateStep } from '../../../shared/protocol.js'
import { dmAgent, JUNIOR_DM } from '../../../core/junior/dms.js'
import { useChatAgent } from '../chatAgents.js'
import { draftStore, useDmDraft } from '../drafts.js'
import { usePersona } from '../junior.js'
import { ChatComposer, type NewSession } from './ChatComposer.js'
import { JuniorFace } from './JuniorFace.js'

type Props = {
  /** the DM key: `junior`, or the agent's name */
  dm: string
  onCreate: (draftId: string, s: NewSession, dm: true) => void
  createError: { draftId: string; message: string } | null
  createStep: { draftId: string; step: CreateStep } | null
}

export function AgentDmStart({ dm, onCreate, createError, createStep }: Props) {
  const persona = usePersona()
  const name = dmAgent(dm)
  const agent = useChatAgent(name)
  const draft = useDmDraft(dm, name)
  // An agent whose file is gone: say so rather than start a DM as plain Junior.
  if (name && !agent) return <div id="empty">This agent isn't in your library any more.</div>
  if (!draft) return null
  const label = agent?.label ?? persona.name
  return (
    <div className="agentDmStart">
      <JuniorFace size={56} motion="still" colour={agent?.colour ?? undefined} decorative />
      <h1>{dm === JUNIOR_DM ? persona.name : label}</h1>
      <p>{agent?.description || 'Your junior engineer. This is your DM: one chat you keep coming back to.'}</p>
      <div className="agentDmCompose">
        <ChatComposer
          key={draft.id}
          placeholder={`Message ${label}…`}
          draft={draft}
          agentLocked
          onChange={(patch) => draftStore.update(draft.id, patch)}
          onCreate={(s) => onCreate(draft.id, { ...s, title: label, agent: name }, true)}
          error={createError?.draftId === draft.id ? createError : null}
          step={createStep?.draftId === draft.id ? createStep.step : null}
        />
      </div>
    </div>
  )
}
