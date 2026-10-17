import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { commandFor } from '../commands.js'
import type { SlashCommandInfo } from '../../../shared/protocol.js'

type Props = {
  text: string
  commands: readonly SlashCommandInfo[]
  /** the textarea this draws behind */
  boxRef: RefObject<HTMLTextAreaElement | null>
}

/** One canvas for every measurement this page ever makes. */
let ctx: CanvasRenderingContext2D | null = null
function measure(s: string, font: string): number {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  return ctx.measureText(s).width
}

/**
 * The lit pill behind a recognized `/command` in the prompt box.
 *
 * A textarea can't style part of its own value, and mirroring the whole draft
 * to fake it is the usual answer, but it isn't needed here, because a command
 * is only ever the first token of the first line. So this measures one
 * substring and parks a rectangle at the box's text origin, with no wrapping
 * to mirror and no selection to keep in step.
 *
 * It lights only for a name that *resolves*: `/release` gets the pill,
 * `/relase` gets nothing. That absence is the whole point: it is how the box
 * says "this will reach the model as prose" without an error state flashing at
 * every half-typed name on the way there.
 */
export function CommandPill({ text, commands, boxRef }: Props) {
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const raf = useRef(0)

  // The name as typed, not as resolved: an alias (`/cost`) is highlighted at
  // the width of what is actually in the box, not of the command it means.
  const typed = /^\/\S+/.exec(text)?.[0]
  const known = commandFor(text, commands) !== null

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !typed || !known) {
      setRect(null)
      return
    }
    const place = () => {
      const cs = getComputedStyle(box)
      // Read the geometry off the element rather than hardcoding it, so the
      // pill follows the composer's own padding and type scale if either moves.
      const top = parseFloat(cs.paddingTop) - box.scrollTop
      // A long draft scrolled past its first line puts the command out of
      // sight; drawing the pill anyway would leave it floating over the tray.
      if (top < 0) {
        setRect(null)
        return
      }
      setRect({
        left: parseFloat(cs.paddingLeft),
        top,
        width: measure(typed, cs.font),
        height: parseFloat(cs.lineHeight),
      })
    }
    place()
    // The box autosizes as the draft grows, and scrolls once it stops growing.
    const onScroll = () => {
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(place)
    }
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      box.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf.current)
    }
  }, [text, typed, known, boxRef])

  if (!rect) return null
  return (
    <span
      className="cmdPill"
      aria-hidden="true"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
    />
  )
}
