/**
 * The Junior page (.docs/junior-goals-teams/junior-home-v2.html, variation J):
 * Junior on the left, the day on the right. The sidebar is Junior's card:
 * Chat (⌘J), right now, what it can see, what it can do, Customize. The
 * right side is a two-tone serif headline over three tabs: Morning brief,
 * Today's plan, Blocked on you. "What I can do" in full and the persona open
 * in a sheet over the page.
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { X } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import type { JuniorDay } from '../../../shared/protocol.js'
import { headline } from '../../../core/junior/greeting.js'
import { overdueCount } from '../../../core/junior/morning.js'
import { pageMood } from '../../../core/junior/mood.js'
import { useWorkspaceId } from '../hooks.js'
import { useAwayWindow, useJuniorDay, usePersona } from '../junior.js'
import { JuniorAbout } from './JuniorAbout.js'
import { JuniorBrief } from './JuniorBrief.js'
import { JuniorCanDo } from './JuniorCanDo.js'
import { JuniorSide } from './JuniorSide.js'
import { JuniorBlocked, JuniorFirstOpen, JuniorGoals } from './JuniorToday.js'
import { JuniorPrs } from './JuniorPrs.js'
import { JuniorLog } from './JuniorLog.js'
import { useLogUnread } from '../juniorLog.js'
import { useInbox } from '../inboxStore.js'

/** What the sheet over the page shows: every capability, or the persona. */
export type JuniorView = 'can' | 'me'

type Tab = 'brief' | 'goals' | 'blocked' | 'prs' | 'log'

type Props = {
  onNavigate: (hash: string) => void
  /** Start on a Junior-owned plan row: the inbox's own dispatch */
  onDispatch: (itemId: string) => void
  /** `#/junior/log`: open on the Log tab */
  initialTab?: 'log'
}

export function JuniorPage({ onNavigate, onDispatch, initialTab }: Props) {
  const workspaceId = useWorkspaceId()
  const persona = usePersona()
  const win = useAwayWindow(workspaceId)
  const { day, error, reload } = useJuniorDay(win)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'brief')
  const [sheet, setSheet] = useState<JuniorView | null>(null)
  const unread = useLogUnread()
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
            people: day.morning.people.length,
            overdue: overdueCount(day.morning),
            plan: { done: day.plan.done, total: day.plan.total },
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [day, persona.voice, persona.name],
  )

  const mood = day
    ? pageMood({ needs: day.needs.length, stuck: day.stuck, working: !day.now.idle, firstOpen: day.firstOpen, planDone: day.plan.done, planTotal: day.plan.total })
    : 'hello'
  const firstOpen = !!day && day.firstOpen && day.plan.total === 0

  return (
    <div className="jrPage" style={{ '--junior': persona.colour } as CSSProperties}>
      <JuniorSide day={day} mood={mood} onNavigate={onNavigate} onSeeAll={() => setSheet('can')} onCustomize={() => setSheet('me')} onDispatch={onDispatch} />

      <main className="jrMain">
        <div className="glow junior" aria-hidden="true" />
        <h1 className="jrHello" aria-live="polite">
          {head ? (
            <>
              <span className="g">{head.greet}</span> {head.news}
            </>
          ) : (
            <span className="g">{persona.name}</span>
          )}
        </h1>
        {error && !day && (
          <p className="jrBrief err" role="alert">
            Couldn't load the day: {error}{' '}
            <button type="button" className="jrRef" onClick={reload}>
              Try again
            </button>
          </p>
        )}

        {firstOpen && day ? (
          <>
            <p className="jrBrief">{firstOpenLine(persona.voice)}</p>
            <JuniorFirstOpen day={day} />
          </>
        ) : (
          <Tabs.Root className="jrTabs" value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <div className="jrBar">
              <Tabs.List className="jrViews" aria-label={persona.name}>
                <Tabs.Trigger className="jrView" value="brief">
                  Morning brief <Count day={day} of="brief" />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="goals">
                  Today's plan <Count day={day} of="goals" />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="blocked">
                  Blocked on you <Count day={day} of="blocked" />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="prs">
                  My PRs <PrCount />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="log">
                  Log {unread && <span className="c dot" aria-label="new" />}
                </Tabs.Trigger>
              </Tabs.List>
            </div>
            <Tabs.Content value="brief" className="jrPane">
              {day ? <JuniorBrief day={day} onNavigate={onNavigate} /> : <Loading />}
            </Tabs.Content>
            <Tabs.Content value="goals" className="jrPane">
              {day ? <JuniorGoals day={day} onNavigate={onNavigate} onDispatch={onDispatch} /> : <Loading />}
            </Tabs.Content>
            <Tabs.Content value="blocked" className="jrPane">
              {day ? <JuniorBlocked day={day} onNavigate={onNavigate} /> : <Loading />}
            </Tabs.Content>
            <Tabs.Content value="prs" className="jrPane">
              <JuniorPrs onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="log" className="jrPane">
              <JuniorLog active={tab === 'log'} onNavigate={onNavigate} />
            </Tabs.Content>
          </Tabs.Root>
        )}
      </main>

      <Dialog.Root open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="projOverlay" />
          <Dialog.Content className="jrSheet" aria-describedby={undefined}>
            <div className="jrSheetHead">
              <Dialog.Title className="t">{sheet === 'can' ? `What ${persona.name} can do` : `About ${persona.name}`}</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="iconBtn" aria-label="Close">
                  <X size={15} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="jrSheetBody">
              {sheet === 'can' && day && <JuniorCanDo fill={day.fill} />}
              {sheet === 'me' && (
                <JuniorAbout
                  routines={day?.routines ?? null}
                  onNavigate={(h) => {
                    setSheet(null)
                    onNavigate(h)
                  }}
                  onView={setSheet}
                />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}

/** The count on a tab: people waiting on the brief (orange), the plan's progress, what blocks Junior (orange). */
function Count({ day, of }: { day: JuniorDay | null; of: Tab }) {
  if (!day) return null
  if (of === 'brief') {
    const n = day.morning.people.length
    return n ? <span className="c hot">{n} waiting</span> : null
  }
  if (of === 'goals') return day.plan.total ? <span className="c">{`${day.plan.done} of ${day.plan.total}`}</span> : null
  return day.needs.length ? <span className="c hot">{day.needs.length}</span> : null
}

/** The PR tab's count: what needs you on your PRs (orange), else how many are open. */
function PrCount() {
  const snap = useInbox()
  const needs = snap.items.filter((i) => (i.tasks?.needsYou ?? 0) > 0).length
  if (needs) return <span className="c hot">{needs}</span>
  const mine = snap.items.filter((i) => i.reason === 'your-pr').length
  return mine ? <span className="c">{mine}</span> : null
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

export type { JuniorDay }
