import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Mood } from '../../../core/junior/mood.js'
import { usePersona } from '../junior.js'
import { JuniorFace } from './JuniorFace.js'
import { Tooltip } from '../ui/Tooltip.js'

/** In a chat, a finished turn or an answered card looks neutral: the closed "^ ^" is kept for when you hover it. */
export const chatMood = (mood: Mood): Mood => (mood === 'done' ? 'hello' : mood)

/**
 * On screen right now. A face that follows the pointer measures itself every
 * frame the pointer moves, so a long transcript lets only the faces you can
 * see follow; the rest sit still until they scroll in.
 */
export function useOnScreen(ref: RefObject<Element | null>): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver(([e]) => setOn(e.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  return on
}

/** What Junior's speech bubble says: a line in its voice, and the facts under it. */
export type Say = string | { line: string; sub?: string }

/**
 * Junior's face in a chat: its eyes follow the pointer while it's on screen,
 * and it notices you, hover it and it lifts, a finished one smiles back, and
 * a speech bubble says what it's at ("Done in 32s · 9 steps", "Waiting on your
 * answer ↓"). A face that's working or waiting on you only lifts: hovering
 * never hides its state. With `onClick` it's a button (the needs-you face
 * jumps to the card it's waiting on).
 */
export function ChatFace({ mood, size, say, onClick }: { mood: Mood; size: number; say?: Say; onClick?: () => void }) {
  const box = useRef<HTMLSpanElement>(null)
  const seen = useOnScreen(box)
  const [hover, setHover] = useState(false)
  const face = (
    <span
      className={`chatFace${onClick ? ' go' : ''}`}
      ref={box}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick && say ? (typeof say === 'string' ? say : `${say.line}. ${say.sub ?? ''}`) : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
      <JuniorFace mood={hover && mood === 'done' ? 'done' : chatMood(mood)} size={size} motion={seen ? 'follow' : 'still'} reach={1.2} features={1.3} decorative />
    </span>
  )
  if (!say) return face
  const { line, sub } = typeof say === 'string' ? { line: say, sub: undefined } : say
  return (
    <Tooltip
      className="junior"
      content={
        <>
          <span className="tipLine">{line}</span>
          {sub && <span className="tipSub">{sub}</span>}
        </>
      }
    >
      {face}
    </Tooltip>
  )
}

/**
 * "Junior …" with its face: who is asking, on the cards junior draws in a chat
 * (questions, approvals, plans). The face shows the state the card is in,
 * needs you while it waits, done once answered. The name is the persona's, so
 * a renamed Junior follows.
 */
export function JuniorLabel({ mood, size = 26, say, children, className }: { mood: Mood; size?: number; say?: Say; children?: ReactNode; className?: string }) {
  const persona = usePersona()
  return (
    <span className={`jrLabel${className ? ` ${className}` : ''}`}>
      <span className="jrFace">
        <ChatFace mood={mood} size={size} say={say} />
      </span>
      <span className="jrWho">{persona.name}</span>
      {children}
    </span>
  )
}
