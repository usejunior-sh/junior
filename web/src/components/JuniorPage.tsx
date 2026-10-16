/**
 * The Junior tab (.docs/junior-goals-teams, direction E): one centred column,
 * like a transcript. The face, where Junior is right now, a two-tone serif
 * headline, the brief (a paragraph, composed from facts, references inline),
 * then Today · What I can do · About me and "New chat with {name}" (⌘J).
 */
import * as Tabs from '@radix-ui/react-tabs'
import { useMemo, useState } from 'react'
import type { BriefTarget, JuniorDay, JuniorNow, Segment } from '../../../shared/protocol.js'
import { composeBrief } from '../../../core/junior/brief.js'
import { headline } from '../../../core/junior/greeting.js'
import { pageMood } from '../../../core/junior/mood.js'
import { itemHash, useWorkspaceId } from '../hooks.js'
import { startJuniorChat, useAwayWindow, useJuniorDay, usePersona } from '../junior.js'
import { MOD_LABEL } from '../keys.js'
import { JuniorAbout } from './JuniorAbout.js'
import { JuniorCanDo } from './JuniorCanDo.js'
import { JuniorFace } from './JuniorFace.js'
import { JuniorToday } from './JuniorToday.js'

export type JuniorView = 'today' | 'can' | 'me'

type Props = {
  onNavigate: (hash: string) => void
  /** Start on a Junior-owned plan row: the inbox's own dispatch */
  onDispatch: (itemId: string) => void
}

/** Where a reference in the brief (or a row) goes. */
export function targetHash(t: BriefTarget): string {
  switch (t.kind) {
    case 'session':
      return t.id
    case 'item':
      return itemHash(t.id)
    case 'job':
      return `/jobs/${encodeURIComponent(t.id)}`
    case 'actions':
      return '/actions'
  }
}

export function JuniorPage({ onNavigate, onDispatch }: Props) {
  const workspaceId = useWorkspaceId()
  const persona = usePersona()
  const win = useAwayWindow(workspaceId)
  const { day, error, reload } = useJuniorDay(win)
  const [view, setView] = useState<JuniorView>('today')
  // The clock the headline reads; the page re-reads it on every fetch.
  const now = Date.now()

  const head = useMemo(
    () =>
      day
        ? headline({
            now,
            voice: persona.voice,
            name: persona.name,
            you: day.you.name,
            firstOpen: day.firstOpen,
            needs: day.needs.length,
            plan: { done: day.plan.done, total: day.plan.total },
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [day, persona.voice, persona.name],
  )
  const brief = useMemo(() => (day && !day.firstOpen ? composeBrief(day.facts, persona.voice, now) : null), [day, persona.voice]) // eslint-disable-line react-hooks/exhaustive-deps

  const mood = day
    ? pageMood({ needs: day.needs.length, stuck: day.stuck, working: !day.now.idle, firstOpen: day.firstOpen, planDone: day.plan.done, planTotal: day.plan.total })
    : 'hello'

  return (
    <div className="jrPage">
      <div className="glow blue" aria-hidden="true" />
      <div className="jrCol">
        <header className="jrWho">
          <div className="jrFace">
            <JuniorFace mood={mood} size={56} motion="follow" />
          </div>
          <div className="jrMsg">
            <h1 className="jrHello" aria-live="polite">
              {head ? (
                <>
                  <span className="g">{head.greet}</span> {head.news}
                </>
              ) : (
                <span className="g">{persona.name}</span>
              )}
            </h1>
            {day ? <NowLine now={day.now} onNavigate={onNavigate} /> : <span className="jrKick">&nbsp;</span>}
            {error && !day && (
              <p className="jrBrief err" role="alert">
                Couldn't load the day: {error}{' '}
                <button type="button" className="jrRef" onClick={reload}>
                  Try again
                </button>
              </p>
            )}
            {day?.firstOpen && <p className="jrBrief">{firstOpenLine(persona.voice)}</p>}
            {brief && <BriefText segments={brief} onNavigate={onNavigate} />}
          </div>
        </header>

        <Tabs.Root className="jrTabs" value={view} onValueChange={(v) => setView(v as JuniorView)}>
          <div className="jrBar">
            <Tabs.List className="jrViews" aria-label={persona.name}>
              <Tabs.Trigger className="jrView" value="today">
                Today
              </Tabs.Trigger>
              <Tabs.Trigger className="jrView" value="can">
                What I can do
              </Tabs.Trigger>
              <Tabs.Trigger className="jrView" value="me">
                About me
              </Tabs.Trigger>
            </Tabs.List>
            <button type="button" className="btn primary jrNew" onClick={() => startJuniorChat()} title={`New chat with ${persona.name} (${MOD_LABEL}J)`}>
              New chat with {persona.name}
            </button>
            <span className="jrKeys" aria-hidden="true">
              <kbd>{MOD_LABEL.replace(/\+$/, '')}</kbd>
              <kbd>J</kbd>
            </span>
          </div>
          <Tabs.Content value="today" className="jrPane">
            {day ? <JuniorToday day={day} onNavigate={onNavigate} onDispatch={onDispatch} onView={setView} /> : <Loading />}
          </Tabs.Content>
          <Tabs.Content value="can" className="jrPane">
            {day ? <JuniorCanDo fill={day.fill} /> : <Loading />}
          </Tabs.Content>
          <Tabs.Content value="me" className="jrPane">
            <JuniorAbout routines={day?.routines ?? null} onNavigate={onNavigate} onView={setView} />
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </div>
  )
}

const Loading = () => (
  <p className="jrLead" role="status">
    Catching up…
  </p>
)

/** First open: who Junior is and how it works, before what it can see. */
function firstOpenLine(voice: string): string {
  if (voice === 'terse') return 'Runs on this Mac, with your logins. Reads back, asks once, sends nothing without OK. I can see:'
  if (voice === 'warm')
    return "I work right here on your Mac, with your tools and logins. I'll always read back what you ask, bundle my questions into one message, and never send anything without your OK. Here's what I can see so far:"
  return "I work on this Mac with your tools and logins. I read back what you ask, put every question in one message with my best guess, and nothing leaves without your OK. Here's what I can see:"
}

/** "● Right now finding the auth test flake · step 2 of 3", or "Free right now". */
function NowLine({ now, onNavigate }: { now: JuniorNow; onNavigate: (hash: string) => void }) {
  if (now.idle)
    return (
      <span className="jrKick">
        <span className="jrDot" aria-hidden="true" />
        Free right now
      </span>
    )
  const hash = now.target.kind === 'session' ? now.target.id : `/jobs/${encodeURIComponent(now.target.id)}`
  return (
    <button type="button" className="jrKick" onClick={() => onNavigate(hash)}>
      <span className="jrDot live" aria-hidden="true" />
      Right now <b>{now.label}</b>
      {now.step && <span className="jrStep"> · step {now.step.n} of {now.step.of}</span>}
      {now.more > 0 && <span className="jrStep"> · {now.more} more running</span>}
    </button>
  )
}

/** The brief: prose, with references as underlined buttons. */
export function BriefText({ segments, onNavigate }: { segments: Segment[]; onNavigate: (hash: string) => void }) {
  return (
    <p className="jrBrief">
      {segments.map((s, i) =>
        typeof s === 'string' ? (
          <span key={i}>{s}</span>
        ) : (
          // A link, not a button: it navigates, and a long title must wrap with the sentence around it.
          <a
            key={i}
            className="jrRef"
            href={`#${targetHash(s.target)}`}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
              e.preventDefault()
              onNavigate(targetHash(s.target))
            }}
          >
            {s.label}
          </a>
        ),
      )}
    </p>
  )
}

export type { JuniorDay }
