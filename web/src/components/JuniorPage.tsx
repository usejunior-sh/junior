/**
 * The Junior page (.docs/junior-goals-teams/junior-home-list.html, artifact
 * 065cfb8a v7, decided Oct 22 2026). Junior up top, centred: the key face in
 * a sky halo that spins while it works and listens while you type, the
 * greeting, a one-line ticker of what it is doing, and the prompt box to hand
 * work off. Under it, sticky pill tabs over one ranked Ledger (JuniorLedger):
 * Needs you · Up next · Reviews · My PRs · With Junior · Waiting, and ⋯ to pick which
 * tabs show (Suggested, People, My work, Today's plan and Log are there too).
 * "What I can do" and the persona open in a sheet from ⋯.
 */
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { Check, MoreHorizontal, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { CreateStep, JuniorDay, ScoredItem } from '../../../shared/protocol.js'
import { headline } from '../../../core/junior/greeting.js'
import { ledgerCount, type LedgerTab } from '../../../core/junior/ledger.js'
import { overdueCount } from '../../../core/junior/morning.js'
import { canDoCards, tryShortcuts } from '../../../core/junior/offers.js'
import { pageMood, type Mood } from '../../../core/junior/mood.js'
import { draftStore, useHomeDraft } from '../drafts.js'
import { itemHash, useWorkspaceId, type JuniorTab } from '../hooks.js'
import { inboxStore, useInbox } from '../inboxStore.js'
import { useAwayWindow, useJuniorDay, usePersona } from '../junior.js'
import { useLogUnread } from '../juniorLog.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { JuniorAbout } from './JuniorAbout.js'
import { JuniorCanDo } from './JuniorCanDo.js'
import { JuniorFace } from './JuniorFace.js'
import { JuniorHalo } from './JuniorHalo.js'
import { JuniorMyWork, JuniorPeople, JuniorSuggested, useHandoffCounts } from './JuniorHandoff.js'
import { JuniorLedger } from './JuniorLedger.js'
import { JuniorLog } from './JuniorLog.js'
import { JuniorFirstOpen, JuniorGoals } from './JuniorToday.js'
import { ChatComposer, type NewSession } from './ChatComposer.js'

/** What the sheet over the page shows: every capability, or the persona. */
export type JuniorView = 'can' | 'me'

type PageTab = LedgerTab | 'suggested' | 'people' | 'work' | 'plan' | 'log'

const TABS: { id: PageTab; name: string }[] = [
  { id: 'needs', name: 'Needs you' },
  { id: 'up', name: 'Up next' },
  { id: 'reviews', name: 'Reviews' },
  { id: 'prs', name: 'My PRs' },
  { id: 'with', name: 'With Junior' },
  { id: 'waiting', name: 'Waiting' },
  { id: 'suggested', name: 'Suggested' },
  { id: 'people', name: 'People' },
  { id: 'work', name: 'My work' },
  { id: 'plan', name: "Today's plan" },
  { id: 'log', name: 'Log' },
]
const LEDGER: readonly PageTab[] = ['needs', 'up', 'reviews', 'prs', 'with', 'waiting']
const EMPTY: Record<LedgerTab, string> = {
  needs: 'I’m not waiting on you. When I need you, it shows up here.',
  up: 'Nothing open. I’ll add things here as they come in.',
  reviews: 'No one is waiting on your review.',
  prs: 'No open PRs in this workspace’s repos.',
  with: 'Nothing is handed to me yet. Open a row and hand it off.',
  waiting: 'You aren’t waiting on anyone.',
}

// Which tabs show: per browser. Needs you always does.
const TABS_KEY = 'junior.home.tabs'
function readShown(): PageTab[] {
  try {
    const v = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null') as unknown
    if (Array.isArray(v)) return TABS.map((t) => t.id).filter((id) => id === 'needs' || v.includes(id))
  } catch {
    // unreadable: the defaults
  }
  return [...LEDGER]
}
function writeShown(ids: PageTab[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(ids))
  } catch {
    // storage blocked: this page load only
  }
}

type Props = {
  onNavigate: (hash: string) => void
  /** Start on a Junior-owned plan row: the inbox's own dispatch */
  onDispatch: (itemId: string) => void
  /** Start a chat from the prompt box: the draft tab's own create */
  onCreate: (draftId: string, s: NewSession) => void
  /** the last create failed; shown when it was this box's */
  createError: { draftId: string; message: string } | null
  /** a send that makes a worktree: the step it is on, for this box's draft */
  createStep: { draftId: string; step: CreateStep } | null
  /** `#/junior/<tab>`: open on that tab */
  initialTab?: JuniorTab
}

/** The inbox snapshot, loaded once the page opens. */
function useItems(): ScoredItem[] {
  const snap = useInbox()
  useEffect(() => {
    if (!snap.loaded && !snap.loading) void inboxStore.refresh()
  }, [snap.loaded, snap.loading])
  return snap.items as ScoredItem[]
}

export function JuniorPage({ onNavigate, onDispatch, onCreate, createError, createStep, initialTab }: Props) {
  const workspaceId = useWorkspaceId()
  const persona = usePersona()
  const win = useAwayWindow(workspaceId)
  const { day, error, reload } = useJuniorDay(win)
  const items = useItems()
  const [shown, setShown] = useState(readShown)
  const [tab, setTab] = useState<PageTab>(initialTab ?? 'needs')
  const handoffCounts = useHandoffCounts(day)
  const [sheet, setSheet] = useState<JuniorView | null>(null)
  const unread = useLogUnread()
  const [listening, setListening] = useState(false)
  const now = Date.now()

  // A link to a hidden tab still opens it.
  const visible = shown.includes(tab) ? shown : TABS.map((t) => t.id).filter((id) => shown.includes(id) || id === tab)
  const pick = (id: PageTab) => {
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : TABS.map((t) => t.id).filter((x) => x === id || shown.includes(x))
    setShown(next)
    writeShown(next)
    if (!next.includes(tab)) setTab('needs')
  }

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

  const working = (!!day && !day.now.idle) || items.some((i) => i.junior?.stage === 'working')
  const mood: Mood = listening
    ? 'listen'
    : day
      ? pageMood({ needs: day.needs.length, stuck: day.stuck, working, firstOpen: day.firstOpen, planDone: day.plan.done, planTotal: day.plan.total })
      : 'hello'
  const spin = working && !listening
  const firstOpen = !!day && day.firstOpen && day.plan.total === 0
  const me = day?.seen?.github ?? null

  const count = (id: PageTab) => {
    if ((LEDGER as readonly string[]).includes(id)) {
      const c = ledgerCount(items, id as LedgerTab)
      // sessions, plans, gates and sends held on you count on Needs you and With Junior
      const held = id === 'needs' || id === 'with' ? (day?.needs.length ?? 0) : 0
      return { n: c.n + (id === 'needs' ? held : 0), hot: c.hot + held }
    }
    if (id === 'suggested') return { n: handoffCounts.suggested, hot: 0 }
    if (id === 'people') return { n: handoffCounts.people[0], hot: handoffCounts.people[1] }
    if (id === 'work') return { n: handoffCounts.work[0], hot: handoffCounts.work[1] }
    return { n: 0, hot: 0 }
  }

  return (
    <div className="jhPage" style={{ '--junior': persona.colour } as CSSProperties}>
      <div className="jhGlow" aria-hidden="true" />
      <header className="jhTop">
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="jhFaceBtn" title={`${persona.name}: customize, what I can see, what I can do`}>
              <JuniorHalo mood={mood} spin={spin} />
              <span className="hint" aria-hidden="true">
                Click me
              </span>
            </button>
          </MenuTrigger>
          <FaceMenu day={day} onSheet={setSheet} />
        </Menu>
        <h1 className="jhHello" aria-live="polite">
          {head ? `${head.greet} ${head.news}` : persona.name}
        </h1>
        {error && !day ? (
          <p className="jhTicker err" role="alert">
            Couldn't load the day: {error}{' '}
            <button type="button" className="jrRef" onClick={reload}>
              Try again
            </button>
          </p>
        ) : (
          <Ticker day={day} items={items} onNavigate={onNavigate} />
        )}
        <HomeComposer
          onCreate={onCreate}
          createError={createError}
          createStep={createStep}
          onListen={setListening}
          starters={
            day &&
            !firstOpen && (
              <>
                {tryShortcuts(day.fill).slice(0, 1).map((t) => (
                  <button key={t.label} type="button" title={t.say} onClick={() => fillHome(t.say)}>
                    {t.label}
                  </button>
                ))}
                <button type="button" onClick={() => setSheet('can')}>
                  More…
                </button>
              </>
            )
          }
        />
        {day?.seen && <SourceLine seen={day.seen} />}
      </header>

      {firstOpen && day ? (
        <div className="jhBody">
          <p className="jrBrief">{firstOpenLine(persona.voice)}</p>
          <JuniorFirstOpen day={day} />
        </div>
      ) : (
        <Tabs.Root className="jhTabsRoot" value={tab} onValueChange={(v) => setTab(v as PageTab)}>
          <div className="jhTabWrap">
            <div className="jhTabs">
              <Tabs.List className="jhTabList" aria-label={persona.name}>
                {TABS.filter((t) => visible.includes(t.id)).map((t) => {
                  const c = count(t.id)
                  return (
                    <Tabs.Trigger key={t.id} className="jhTab" value={t.id}>
                      {t.name}
                      {t.id === 'log' ? unread && <span className="dot" aria-label="new" /> : t.id === 'plan' ? day && day.plan.total > 0 && <span className="n">{`${day.plan.done}/${day.plan.total}`}</span> : c.hot > 0 ? <span className="n hot">{c.hot}</span> : c.n > 0 && <span className="n">{c.n}</span>}
                    </Tabs.Trigger>
                  )
                })}
              </Tabs.List>
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className="jhTab more" aria-label="Pick which tabs show" title="Pick which tabs show">
                    <MoreHorizontal size={15} aria-hidden="true" />
                  </button>
                </MenuTrigger>
                <MenuContent align="end" className="jhTabMenu">
                  <div className="uiMenuCap">Tabs</div>
                  {TABS.map((t) => (
                    <MenuItem
                      key={t.id}
                      disabled={t.id === 'needs'}
                      onSelect={(e) => {
                        e.preventDefault()
                        pick(t.id)
                      }}
                    >
                      <span className="ck">{shown.includes(t.id) && <Check size={13} aria-hidden="true" />}</span>
                      {t.name}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuItem onSelect={() => setSheet('can')}>What {persona.name} can do</MenuItem>
                  <MenuItem onSelect={() => setSheet('me')}>About {persona.name}</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </div>
          <div className="jhBody">
            {(LEDGER as readonly PageTab[]).map((id) => (
              <Tabs.Content key={id} value={id} className="jrPane">
                {tab === id && <JuniorLedger tab={id as LedgerTab} items={items} needs={day?.needs ?? []} me={me} empty={EMPTY[id as LedgerTab]} onNavigate={onNavigate} />}
              </Tabs.Content>
            ))}
            <Tabs.Content value="suggested" className="jrPane">
              <JuniorSuggested day={day} onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="people" className="jrPane">
              <JuniorPeople onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="work" className="jrPane">
              <JuniorMyWork onNavigate={onNavigate} />
            </Tabs.Content>
            <Tabs.Content value="plan" className="jrPane">
              {day ? (
                <JuniorGoals day={day} onNavigate={onNavigate} onDispatch={onDispatch} />
              ) : (
                <p className="jrLead" role="status">
                  Catching up…
                </p>
              )}
            </Tabs.Content>
            <Tabs.Content value="log" className="jrPane">
              <JuniorLog active={tab === 'log'} onNavigate={onNavigate} />
            </Tabs.Content>
          </div>
        </Tabs.Root>
      )}

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

/** "acme/web#3312", or the item's home for anything that isn't a PR. */
const refOf = (i: ScoredItem) => {
  const m = /#(\d+)$/.exec(i.id)
  return m && i.source === 'github' ? `${i.repo}#${m[1]}` : i.repo
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

const jobsOn = (n: number) => (n > 0 ? `${n} ${n === 1 ? 'job' : 'jobs'} on` : null)

/**
 * Right now, in one line. Working: what it is doing, turning over every few
 * seconds, and the jobs on. Free: nothing.
 */
function Ticker({ day, items, onNavigate }: { day: JuniorDay | null; items: ScoredItem[]; onNavigate: (hash: string) => void }) {
  const lines = useMemo(() => {
    const out: { text: string; ref: string | null; go: string }[] = []
    if (day && !day.now.idle) {
      const t = day.now.target
      out.push({ text: capital(day.now.label), ref: day.now.step ? `step ${day.now.step.n} of ${day.now.step.of}` : null, go: t.kind === 'session' ? t.id : `/jobs/${encodeURIComponent(t.id)}` })
    }
    for (const i of items) {
      if (i.junior?.stage !== 'working') continue
      out.push({ text: capital(i.tasks?.line ?? 'Working on'), ref: refOf(i), go: itemHash(i.id) })
    }
    return out
  }, [day, items])
  const [n, setN] = useState(0)
  const [fading, setFading] = useState(false)
  useEffect(() => {
    if (lines.length < 2) return
    let swap: ReturnType<typeof setTimeout> | undefined
    const t = setInterval(() => {
      setFading(true)
      swap = setTimeout(() => {
        setN((x) => x + 1)
        setFading(false)
      }, 350)
    }, 2800)
    return () => {
      clearInterval(t)
      clearTimeout(swap)
    }
  }, [lines.length])
  if (!day) return null
  const jobs = jobsOn(day.jobsOn)
  const line = lines.length ? lines[n % lines.length]! : null
  if (!line) return null
  return (
    <p className="jhTicker">
      <span className="pulse" aria-hidden="true" />
      <button type="button" className={`txt${fading ? ' out' : ''}`} onClick={() => onNavigate(line.go)}>
        {line.text}
        {line.ref && (
          <>
            {' · '}
            <b>{line.ref}</b>
          </>
        )}
      </button>
      {jobs && <span className="jobs">· {jobs}</span>}
    </p>
  )
}

/** Click the face: Customize, What I can do, and what Junior can see on this Mac. */
function FaceMenu({ day, onSheet }: { day: JuniorDay | null; onSheet: (v: JuniorView) => void }) {
  const persona = usePersona()
  const seen = day?.seen ?? null
  const on = seen?.sources.filter((s) => s.connected) ?? []
  const off = seen ? offSources(seen) : []
  return (
    <MenuContent align="center" className="jhFaceMenu">
      <div className="hd">
        <JuniorFace mood="hello" size={32} motion="still" decorative />
        <div>
          <b>{persona.name}</b>
          <span>Your junior engineer · on this Mac</span>
        </div>
      </div>
      <MenuItem onSelect={() => onSheet('me')}>
        Customize<span className="k">name, colour, voice</span>
      </MenuItem>
      <MenuItem onSelect={() => onSheet('can')}>
        What I can do<span className="k">{day ? `${canDoCards(day.fill).length} things` : ''}</span>
      </MenuItem>
      <MenuSeparator />
      <div className="uiMenuCap">What I can see</div>
      {!seen ? (
        <div className="src">Checking…</div>
      ) : (
        <>
          {seen.github && (
            <div className="src">
              <i />
              GitHub<small>@{seen.github}</small>
            </div>
          )}
          {off.map((name) => (
            <MenuItem key={name} asChild>
              <a className="src off" href="#/settings/connectors">
                <i />
                {name}
                <small>signed out</small>
                <span className="go">Sign in</span>
              </a>
            </MenuItem>
          ))}
          {on.length > 0 && (
            <div className="src" title={on.map((s) => s.name).join(', ')}>
              <i />
              {on.length} {on.length === 1 ? 'source' : 'sources'}
              <small>connected</small>
            </div>
          )}
          {seen.projects.length > 0 && <div className="src proj">Projects: {seen.projects.join(' · ')}</div>}
        </>
      )}
    </MenuContent>
  )
}

/**
 * What is signed out that Junior relies on: gh, and Slack (the built-in
 * scanners). Every other MCP server is listed whether or not anyone uses it,
 * so one signed out says nothing on its own.
 */
function offSources(seen: NonNullable<JuniorDay['seen']>): string[] {
  const out: string[] = []
  if (!seen.github) out.push('GitHub')
  const slack = seen.sources.find((s) => /slack/i.test(s.name))
  if (slack && !slack.connected) out.push('Slack')
  return out
}

/** One line under the box, only when something Junior relies on is signed out. */
function SourceLine({ seen }: { seen: NonNullable<JuniorDay['seen']> }) {
  const off = offSources(seen)
  if (off.length === 0) return null
  return (
    <p className="jhSrc">
      <span className="dot" aria-hidden="true" />
      {off.join(' and ')} {off.length === 1 ? 'is' : 'are'} signed out. <a href="#/settings/connectors">Sign in again</a>
    </p>
  )
}

/** Write into the home box and put the caret in it: a shortcut fills it, never sends. */
function fillHome(text: string) {
  const d = draftStore.all().find((x) => x.home)
  if (!d) return
  draftStore.update(d.id, { text })
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.jhComposeWrap textarea')?.focus())
}

/**
 * The prompt box: the same composer a new tab has (project, branch, attachments,
 * @ and /, model, mode, Fast, the starters), drawn for this page. It keeps a
 * draft of its own, so what you type survives leaving the page; send starts
 * the chat the way a new tab's first send does.
 */
function HomeComposer({
  onCreate,
  createError,
  createStep,
  onListen,
  starters,
}: {
  onCreate: Props['onCreate']
  createError: Props['createError']
  createStep: Props['createStep']
  onListen: (on: boolean) => void
  starters: ReactNode
}) {
  const draft = useHomeDraft()
  const wrap = useRef<HTMLDivElement>(null)

  // ⌘J on this page is the box, not a new tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        e.stopImmediatePropagation()
        wrap.current?.querySelector('textarea')?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  if (!draft) return null
  return (
    <div
      ref={wrap}
      className="jhComposeWrap"
      onFocus={(e) => e.target.tagName === 'TEXTAREA' && onListen(true)}
      onBlur={(e) => e.target.tagName === 'TEXTAREA' && onListen(false)}
    >
      <ChatComposer
        key={draft.id}
        placeholder="Hand me something, or ask me anything…"
        draft={draft}
        onChange={(patch) => draftStore.update(draft.id, patch)}
        onCreate={(s) => onCreate(draft.id, s)}
        error={createError?.draftId === draft.id ? createError : null}
        step={createStep?.draftId === draft.id ? createStep.step : null}
        starters={starters}
      />
    </div>
  )
}

/** First open: who Junior is and how it works, before what it can see. */
function firstOpenLine(voice: string): string {
  if (voice === 'terse') return 'Runs on this Mac, with your logins. Reads back, asks once, sends nothing without OK. I can see:'
  if (voice === 'warm')
    return "I work right here on your Mac, with your tools and logins. I'll always read back what you ask, bundle my questions into one message, and never send anything without your OK. Here's what I can see so far:"
  return "I work on this Mac with your tools and logins. I read back what you ask, put every question in one message with my best guess, and nothing leaves without your OK. Here's what I can see:"
}

export type { JuniorDay }
