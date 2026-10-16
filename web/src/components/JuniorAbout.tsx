/**
 * About me: how Junior looks and talks (saved per workspace, fed to its
 * chats' and jobs' system prompts), the rules nothing can change, and the
 * parts that don't exist yet, said honestly. Name, colour and voice repaint
 * the whole app as soon as they are saved.
 */
import * as RadioGroup from '@radix-ui/react-radio-group'
import { Lock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { DEFAULT_NAME, NAME_MAX, RULES_SHORT, SWATCHES, VOICE_HINT, VOICE_LABEL, VOICES, cleanName, type Voice } from '../../../core/junior/persona.js'
import type { JuniorDay } from '../../../shared/protocol.js'
import { savePersona, startJuniorChat, usePersona } from '../junior.js'
import type { JuniorView } from './JuniorPage.js'

type Props = {
  routines: JuniorDay['routines'] | null
  onNavigate: (hash: string) => void
  onView: (v: JuniorView) => void
}

export function JuniorAbout({ routines, onNavigate, onView }: Props) {
  const persona = usePersona()
  const [name, setName] = useState(persona.name)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setName(persona.name), [persona.name])

  const save = async (patch: Parameters<typeof savePersona>[0]) => {
    const r = await savePersona(patch)
    setError(typeof r === 'string' ? r : null)
  }
  const commitName = () => {
    const next = cleanName(name)
    setName(next)
    if (next !== persona.name) void save({ name: next })
  }

  const style = persona.replyStyle
  const changeStyle = () =>
    startJuniorChat(
      style
        ? `I want to change how you reply to me. Right now it's: "${style}". Ask me what I'd like instead, then save it with set_reply_style.`
        : 'I want to tell you how to reply to me. Ask me what I like (length, tone, format), then save it with set_reply_style.',
    )

  return (
    <>
      <h2 className="jrLh">How I look and talk</h2>
      <div className="jrMe">
        <div className="mrow">
          <label className="ml" htmlFor="jrName">
            Name
          </label>
          <span className="mv">
            <input
              id="jrName"
              className="jrName"
              value={name}
              maxLength={NAME_MAX}
              placeholder={DEFAULT_NAME}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setName(persona.name)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
            <span className="hint">Shows in the rail, in chats and in every report.</span>
          </span>
        </div>
        <div className="mrow">
          <span className="ml" id="jrColourL">
            Colour
          </span>
          <span className="mv">
            <RadioGroup.Root className="jrSwatches" aria-labelledby="jrColourL" value={persona.colour} onValueChange={(c) => void save({ colour: c })} orientation="horizontal">
              {SWATCHES.map(([label, hex]) => (
                <RadioGroup.Item key={hex} value={hex} className="sw" title={label} aria-label={label} style={{ background: hex }} />
              ))}
            </RadioGroup.Root>
          </span>
        </div>
        <div className="mrow">
          <span className="ml" id="jrVoiceL">
            Voice
          </span>
          <span className="mv">
            <RadioGroup.Root className="seg" aria-labelledby="jrVoiceL" value={persona.voice} onValueChange={(v) => void save({ voice: v as Voice })} orientation="horizontal">
              {VOICES.map((v) => (
                <RadioGroup.Item key={v} value={v} className={`segBtn${persona.voice === v ? ' active' : ''}`}>
                  {VOICE_LABEL[v]}
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
            <span className="hint">{VOICE_HINT[persona.voice]}</span>
          </span>
        </div>
        <div className="mrow">
          <span className="ml">How I reply to you</span>
          <span className="mv">
            {style ? <span className="quote">“{style}”</span> : <span className="none">Not said yet. I keep it short and plain.</span>}
            <button type="button" className="btn sm ghost" onClick={changeStyle}>
              Change
            </button>
          </span>
        </div>
        <div className="mrow">
          <span className="ml">Rules I always keep</span>
          <span className="mv">
            <span>{RULES_SHORT.join(' · ')}</span>
            <span className="lock">
              <Lock size={10} aria-hidden="true" /> can't be changed
            </span>
          </span>
        </div>
      </div>
      {error && (
        <p className="jrErr" role="alert">
          Couldn't save: {error}
        </p>
      )}

      {/* TODO(junior): a real "learned about you" memory needs Samar's decision. */}
      <h2 className="jrLh">What I've learned about you</h2>
      <p className="jrEmpty">Nothing yet. I don't keep a memory of you yet; when I do, everything I learn will show here, and you can make me forget it.</p>

      {/* TODO(junior): earned-trust rules need Samar's decision. */}
      <h2 className="jrLh">What I may do without asking</h2>
      <p className="jrEmpty">Nothing yet. Everything waits for your OK.</p>

      <h2 className="jrLh">Routines you taught me</h2>
      {routines === null ? (
        <p className="jrEmpty">Looking…</p>
      ) : routines.length === 0 ? (
        <p className="jrEmpty">
          None yet.{' '}
          <button type="button" className="jrRef" onClick={() => onView('can')}>
            Teach me one
          </button>
          : a skill or a subagent in this workspace's library, usable in every session.
        </p>
      ) : (
        <p className="jrAlso">
          {routines.map((r, i) => (
            <span key={r.path}>
              {i > 0 && ', '}
              <button type="button" title={`${r.kind === 'skill' ? 'Skill' : 'Agent'} · ${r.path}`} onClick={() => onNavigate(`/settings/${r.kind === 'skill' ? 'skills' : 'agents'}`)}>
                {r.name.replace(/^triage:/, '')}
              </button>
            </span>
          ))}
          . Every session here can use them.
        </p>
      )}
    </>
  )
}
