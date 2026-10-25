import { X } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { ChatAgent } from '../../../core/junior/agents.js'
import { usePersona } from '../junior.js'

/**
 * The picked chat agent's name over the big headline (the Junior page, a new
 * chat): a mono eyebrow, "● JUNIOR · REVIEWER ×", in the agent's colour dot.
 * The × goes back to plain Junior. Nothing when no agent is picked.
 */
export function AgentEyebrow({ agent, onClear }: { agent: ChatAgent | null; onClear?: () => void }) {
  const persona = usePersona()
  if (!agent) return null
  return (
    <p className="agEyebrow" title={agent.description} style={agent.colour ? ({ '--agent': agent.colour } as CSSProperties) : undefined}>
      <span className="dot" aria-hidden="true" />
      <span>
        {persona.name} · <b>{agent.label}</b>
      </span>
      {onClear && (
        <button type="button" className="agEyebrowX" onClick={onClear} aria-label={`Back to plain ${persona.name}`} title={`Back to plain ${persona.name}`}>
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </p>
  )
}
