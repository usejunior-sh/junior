/**
 * A new tab: the Junior page's top, the big face in its halo over a centred
 * line, asking what you're working on. The face reacts to the box under it
 * (ChatComposer), the halo spins while a worktree is made, and it nods "On
 * it." when you send.
 * A connected agent (Codex) gets a plain heading instead.
 */
import { useEffect, useMemo, useState, type ComponentProps } from 'react'
import { sessionAsk } from '../../../core/junior/greeting.js'
import { usePersona, useYouName } from '../junior.js'
import { ChatComposer, type ComposerTop } from './ChatComposer.js'
import { JuniorHalo } from './JuniorHalo.js'
import { splitTyped } from '../typed.js'

export type { NewSession } from './ChatComposer.js'

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Junior's line, typed in once: `text` grows a character at a time until it is
 * all there. Reduced motion shows it whole. A new `text` types again.
 */
function useTyped(text: string): string {
  const [n, setN] = useState(() => (reducedMotion() ? text.length : 0))
  useEffect(() => {
    if (reducedMotion()) {
      setN(text.length)
      return
    }
    setN(0)
    let i = 0
    const t = setInterval(() => {
      i++
      setN(i)
      if (i >= text.length) clearInterval(t)
    }, 24)
    return () => clearInterval(t)
  }, [text])
  return text.slice(0, n)
}

type Props = Omit<ComponentProps<typeof ChatComposer>, 'top' | 'placeholder' | 'id'>

/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer(props: Props) {
  return <ChatComposer {...props} id="newSessionHome" top={(s) => <Greeting s={s} />} />
}

function Greeting({ s }: { s: ComposerTop }) {
  const persona = usePersona()
  const you = useYouName()
  // Junior's line in the bubble: a greeting by time of day, then the question; "On it." once you send.
  const { greet, ask } = useMemo(() => sessionAsk(Date.now(), persona.voice, you), [persona.voice, you])
  const question = s.job ? 'Tell me about the job.' : s.goal ? 'Tell me about the goal.' : s.dispatched ? 'Anything I should know before I start?' : ask
  const said = useTyped(s.handoff ? 'On it.' : `${greet} ${question}`)
  // The whole line is always there, the untyped tail hidden, so the heading never grows or re-wraps while it types.
  const [[g, gRest], [q, qRest]] = splitTyped(s.handoff ? ['On it.', ''] : [greet, ` ${question}`], said.length)
  return (
    <>
      <div className={`glow ${s.onClaude ? 'junior' : 'blue'}`} aria-hidden="true" />
      {s.onClaude ? (
        // Junior is Claude here: it asks, its face beside the line, and the face reacts to you.
        <div className={`nsWho${s.handoff ? ' handoff' : ''}`}>
          <span className="nsFace">
            <JuniorHalo mood={s.mood} spin={s.mood === 'working'} look={s.look} />
          </span>
          <h2 className="nsLine" aria-label={s.handoff ? 'On it.' : `${greet} ${question}`}>
            <span aria-hidden="true">
              {s.handoff ? (
                <>
                  {g}
                  <span className="nsRest">{gRest}</span>
                </>
              ) : (
                <>
                  <span className="g">
                    {g}
                    <span className="nsRest">{gRest}</span>
                  </span>
                  {q}
                  <span className="nsRest">{qRest}</span>
                </>
              )}
            </span>
          </h2>
        </div>
      ) : (
        // A connected agent (Codex) gets the plain heading.
        <h2>{s.job ? 'Tell me about the job.' : s.goal ? 'Tell me about the goal.' : s.dispatched ? 'Dispatching.' : 'What are we working on?'}</h2>
      )}
    </>
  )
}
