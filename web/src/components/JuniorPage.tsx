/**
 * The Junior page (.docs/junior-goals-teams/junior-home-v2.html, variation J;
 * hand-offs, Phase 1, artifact f335b876): Junior on the left, the day on the
 * right. The sidebar is Junior's card: Chat (⌘J), right now, what it can see,
 * what it can do, Customize. The right side is a two-tone serif headline over
 * the tabs: Suggested (with FYI, what's due and what happened), My PRs,
 * Reviews, People, My work, With Junior (blocked on you folds in here),
 * Today's plan, Log. Junior works
 * only what you hand it. "What I can do" in full and the persona open in a
 * sheet over the page.
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { X } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import type { JuniorDay } from '../../../shared/protocol.js'
import { headline } from '../../../core/junior/greeting.js'
import { overdueCount } from '../../../core/junior/morning.js'
import { pageMood } from '../../../core/junior/mood.js'
import { useWorkspaceId, type JuniorTab } from '../hooks.js'
import { useAwayWindow, useJuniorDay, usePersona } from '../junior.js'
import { JuniorAbout } from './JuniorAbout.js'
import { JuniorCanDo } from './JuniorCanDo.js'
import { JuniorSide } from './JuniorSide.js'
import { JuniorFirstOpen, JuniorGoals } from './JuniorToday.js'
import { JuniorMyPrs, JuniorMyWork, JuniorPeople, JuniorReviews, JuniorSuggested, JuniorWith, useHandoffCounts } from './JuniorHandoff.js'
import { JuniorLog } from './JuniorLog.js'
import { useLogUnread } from '../juniorLog.js'

/** What the sheet over the page shows: every capability, or the persona. */
export type JuniorView = 'can' | 'me'

type Tab = 'suggested' | 'prs' | 'reviews' | 'people' | 'work' | 'with' | 'goals' | 'log'

type Props = {
  onNavigate: (hash: string) => void
  /** Start on a Junior-owned plan row: the inbox's own dispatch */
  onDispatch: (itemId: string) => void
  /** `#/junior/<tab>`: open on that tab */
  initialTab?: JuniorTab
}

export function JuniorPage({ onNavigate, onDispatch, initialTab }: Props) {
  const workspaceId = useWorkspaceId()
  const persona = usePersona()
  const win = useAwayWindow(workspaceId)
  const { day, error, reload } = useJuniorDay(win)
  const [tab, setTab] = useState<Tab>(initialTab === 'plan' ? 'goals' : (initialTab ?? 'suggested'))
  const counts = useHandoffCounts(day)
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
                <Tabs.Trigger className="jrView" value="suggested">
                  Suggested {counts.suggested > 0 && <span className="c hot">{counts.suggested}</span>}
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="prs">
                  My PRs <Count n={counts.prs} />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="reviews">
                  Reviews <Count n={counts.reviews} />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="people">
                  People <Count n={counts.people} />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="work">
                  My work <Count n={counts.work} />
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="with">
                  With Junior {counts.with[1] > 0 ? <span className="c hot">{counts.with[1]} for you</span> : counts.with[0] > 0 && <span className="c">{counts.with[0]}</span>}
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="goals">
                  Today's plan {day && day.plan.total > 0 && <span className="c">{`${day.plan.done} of ${day.plan.total}`}</span>}
                </Tabs.Trigger>
                <Tabs.Trigger className="jrView" value="log">
                  Log {unread && <span className="c dot" aria-label="new" />}
                </Tabs.Trigger>
              </Tabs.List>
            </div>
            <Tabs.Content value="suggested" className="jrPane">
              <JuniorSuggested day={day} onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="prs" className="jrPane">
              <JuniorMyPrs onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="reviews" className="jrPane">
              <JuniorReviews onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="people" className="jrPane">
              <JuniorPeople onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="work" className="jrPane">
              <JuniorMyWork onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="with" className="jrPane">
              <JuniorWith day={day} onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="goals" className="jrPane">
              {day ? <JuniorGoals day={day} onNavigate={onNavigate} onDispatch={onDispatch} /> : <Loading />}
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

/** A tab's count: how many (grey), or how many need you (orange) when any do. */
function Count({ n: [all, hot] }: { n: [number, number] }) {
  if (hot) return <span className="c hot">{hot}</span>
  return all ? <span className="c">{all}</span> : null
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
