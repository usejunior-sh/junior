/**
 * Junior's big face in its sky halo, the top of the Junior page and of a new
 * chat. The halo spins and the face bobs while `spin` is on (Junior working);
 * otherwise only the hairline ring shows. Styles: `.jhHalo` in junior.css.
 */
import type { CSSProperties } from 'react'
import type { Mood } from '../../../core/junior/mood.js'
import type { ChatAgent } from '../../../core/junior/agents.js'
import { JuniorFace } from './JuniorFace.js'

type Props = {
  mood: Mood
  spin: boolean
  /** look here instead of at the pointer (the new chat looks at the box as you type) */
  look?: { x: number; y: number } | null
  /** the chat agent picked in the box under it: the face and ring wear its colour (its name: AgentEyebrow) */
  agent?: ChatAgent | null
}

export function JuniorHalo({ mood, spin, look = null, agent }: Props) {
  return (
    <span className={`jhHalo${spin ? ' on' : ''}${agent ? ' agent' : ''}`} style={agent?.colour ? ({ '--junior': agent.colour } as CSSProperties) : undefined}>
      <span className="sat" aria-hidden="true">
        <i />
        <i />
      </span>
      <span className={spin ? 'bob' : ''}>
        <JuniorFace mood={mood} size={118} motion="follow" look={look} colour={agent?.colour ?? undefined} />
      </span>
    </span>
  )
}
