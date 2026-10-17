/**
 * What I can do: eight sentences, blanks filled from this Mac, projects, top
 * items, refs. Click a blank to cycle it; Start opens a Junior chat with the
 * sentence as its first message, waiting for you to send it.
 */
import { useMemo, useState } from 'react'
import type { CanDoFill } from '../../../shared/protocol.js'
import { canDoCards, sentenceOf, type CanDoCard } from '../../../core/junior/offers.js'
import { startJuniorChat } from '../junior.js'

export function JuniorCanDo({ fill }: { fill: CanDoFill }) {
  const cards = useMemo(() => canDoCards(fill), [fill])
  return (
    <>
      <p className="jrLead">
        Swap any underlined part, then start. I fill the blanks from what's on this Mac. These are examples, not a menu: for anything else, just ask in a new chat.
      </p>
      <div className="jrCards">
        {cards.map((c) => (
          <Card key={c.id} card={c} />
        ))}
      </div>
    </>
  )
}

function Card({ card }: { card: CanDoCard }) {
  const blanks = card.parts.filter((p) => typeof p !== 'string').length
  const [picks, setPicks] = useState<number[]>(() => Array(blanks).fill(0))
  let b = -1
  return (
    <div className="jrCard">
      <h3>{card.head}</h3>
      <div className="sent">
        {card.parts.map((p, i) => {
          if (typeof p === 'string') return <span key={i}>{p}</span>
          const at = ++b
          const n = p.options.length
          const cur = p.options[picks[at] % n]
          return (
            <button
              key={i}
              type="button"
              className="blank"
              title={n > 1 ? `Swap: ${p.options.filter((o) => o !== cur).join(' · ')}` : undefined}
              disabled={n < 2}
              onClick={() => setPicks((xs) => xs.map((x, j) => (j === at ? (x + 1) % n : x)))}
            >
              {cur}
            </button>
          )
        })}
      </div>
      <div className="send">
        <button type="button" className="btn sm" onClick={() => startJuniorChat(sentenceOf(card, picks), card.intent ? { intent: card.intent } : {})}>
          Start
        </button>
        <span>{card.note}</span>
      </div>
    </div>
  )
}
