/**
 * The Junior page's list, the Ledger (.docs/junior-goals-teams/junior-home-list.html,
 * artifact 065cfb8a v7). One line per row: who · title · Junior's state in sky
 * · where · age (orange only when a person waits) · chevron. Rows start
 * closed; a click or Space opens one as a bordered card, its Message or
 * Context, what Junior says and the actions aligned to the row's columns.
 * Many can be open; Esc closes all. J/K move, ⏎ acts on an open row only,
 * S snoozes, D marks done, O opens the item. On Needs you, N marks an open
 * item row "not useful": it leaves until something new happens on it, and a
 * one-line notice holds its slot for 5 s with Undo (U).
 *
 * Which rows a tab shows and the words on them are core/junior/ledger.ts.
 * Every verb here is local or a hand-off; sends stay held for approval.
 */
import { ChevronRight, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HandoffReadiness, NeedsRow, ScoredItem, WatchId } from '../../../shared/protocol.js'
import { ageHot, cantWatchOf, juniorState, LEDGER_GROUP_TITLE, ledgerGroup, ledgerProgress, ledgerRows, NOT_USEFUL_HOLD_MAX_MS, NOT_USEFUL_NOTICE_MS, watchOffOf, type LedgerGroup, type LedgerTab } from '../../../core/junior/ledger.js'
import { TURN_ON_LABEL, WATCH_CANT_SAYS, WATCH_OFF_SAYS, WATCH_STILL_OFF, withAnswer } from '../../../core/junior/watch-off.js'
import { itemHash } from '../hooks.js'
import { doneItem, markNotUseful, sendHandoff, snoozeItem, turnOnWatch, undoNotUseful, VERB, type HandoffVerb } from '../handoff.js'
import { anyDialogOpen, isGoSequence, isTypingTarget } from '../keys.js'
import { kindIcon, shortAge } from '../itemUi.js'
import { isMobile, useIsMobile } from '../useMobile.js'
import { JuniorFace } from './JuniorFace.js'
import { SnoozeMenu } from './SnoozeMenu.js'
import { TurnOnButton, WatchCap } from './WatchOff.js'

type Nav = { onNavigate: (hash: string) => void }

/** FYI rows shown on Up next before "more in your inbox". */
const FYI_SHOWN = 6

/** The notice's collapse, matched by `.jhGone.out` in junior.css. */
const GONE_OUT_MS = 120

/**
 * A row just marked not useful: the notice in its slot (`at`, its index in the
 * list), how to put it back, when it was marked (the hold's cap counts from
 * there) and the mark's request (an undo waits for it).
 */
type Gone = { item: ScoredItem; at: number; wasOpen: boolean; leaving: boolean; markedAt: number; marking: Promise<string | null> }

/** One line of the ledger: an inbox item, or something Junior is held on (a blocked session, a plan, sends). */
type Line = { key: string; group: LedgerGroup; item: ScoredItem; need?: undefined } | { key: string; group: LedgerGroup; need: NeedsRow; item?: undefined }

/** "acme/web#3312", or the item's home for anything that isn't a PR. */
const refOf = (i: ScoredItem) => {
  const m = /#(\d+)$/.exec(i.id)
  return m && i.source === 'github' ? `${i.repo}#${m[1]}` : i.repo
}

const initials = (name: string) =>
  name
    .replace(/^@/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '·'

/** Who the row is about: the person who asked, you for your own, Junior for a job's find. */
function whoOf(i: ScoredItem, me: string | null): string {
  if (i.kind === 'manual' || (me && i.author === me)) return 'You'
  if (!i.author) return i.source === 'job' ? 'Junior' : '—'
  return i.author.replace(/^@/, '')
}

/** The playbook a hand-off starts: the suggestion's, else a reply on Slack, a fix for a bug, else a look into it. */
const playbookOf = (i: ScoredItem): string => i.suggestion?.playbook ?? (i.reason === 'asked' && i.source === 'slack' ? 'answer' : i.label === 'bug' ? 'debug-fix' : 'investigate')

/** The one verb ⏎ does on an open row; `watch` when it turns a switched-off watch on. */
type Primary = { label: string; run: () => void; watch?: WatchId }

type Act = (verb: HandoffVerb, id: string, playbook?: string) => void
type TurnOn = (watch: WatchId, id: string) => void

function primaryOf(i: ScoredItem, act: Act, open: () => void, turnOn: TurnOn): Primary {
  // a local switch, not a send: safe on ⏎, its label and limit on screen
  const off = watchOffOf(i)
  if (off) return { label: TURN_ON_LABEL[off], run: () => turnOn(off, i.id), watch: off }
  if (i.junior?.stage === 'needs-you' || i.tasks?.review?.state === 'ready' || i.tasks?.review?.state === 'failed') return { label: i.tasks?.review?.state === 'ready' ? 'Read pass' : 'Open', run: open }
  if (i.handoff === 'paused') return { label: 'Resume', run: () => act('resume', i.id) }
  if (i.handoff === 'on' && (i.junior?.stage === 'working' || i.junior?.stage === 'watching')) return { label: 'Pause', run: () => act('pause', i.id) }
  if (i.handoff === 'on' || i.junior) return { label: 'Open', run: open }
  if (i.suggestion) {
    const pb = i.suggestion.playbook
    return { label: VERB[pb] ?? 'Hand off', run: () => act('start', i.id, pb === 'babysit' || pb === 'review' ? undefined : pb) }
  }
  if (i.reason === 'your-pr') return { label: 'Babysit', run: () => act('start', i.id) }
  if (i.reason === 'review-requested') return { label: 'First pass', run: () => act('start', i.id) }
  return { label: 'Hand to Junior', run: () => act('start', i.id, playbookOf(i)) }
}

/** What the source said: the message, or the context around it. */
function contextOf(i: ScoredItem): string {
  const s = i.seen
  const bits: string[] = []
  if (s?.red.length) bits.push(`CI red: ${s.red.slice(0, 3).join(', ')}`)
  else if (i.ciFailing) bits.push('CI failing')
  if (s?.people) bits.push(`${s.people} open thread${s.people === 1 ? '' : 's'}`)
  if (s?.bots) bits.push(`${s.bots} bot comment${s.bots === 1 ? '' : 's'}`)
  const asks = [...new Set((i.linked ?? []).filter((l) => l.source === 'slack').map((l) => l.author).filter(Boolean))]
  if (asks.length) bits.push(`${asks.join(', ')} asked in Slack too`)
  const lead = i.description?.trim() || i.why?.trim() || i.rankWhy
  return [lead, ...bits].filter(Boolean).join(' · ')
}

/** What Junior says about it, in a sentence. */
function juniorSays(i: ScoredItem): string {
  if (i.handoff === 'paused') return 'Paused. Nothing runs until you resume.'
  if (i.junior?.stage === 'needs-you') return i.tasks?.next?.title ? `I need you: ${i.tasks.next.title}.` : 'I need you here. Open it to see.'
  // never "nothing to do" while the watch is off: nothing will run until you turn it on
  const off = watchOffOf(i)
  if (off) return WATCH_OFF_SAYS[off]
  const cant = cantWatchOf(i)
  if (cant) return WATCH_CANT_SAYS[cant]
  const r = i.tasks?.review
  if (r?.state === 'ready') return r.line ?? 'My first pass is ready. Nothing is posted.'
  if (r?.state === 'reviewing') return 'Reading the diff now.'
  if (r?.state === 'queued') return 'Queued for a first pass.'
  if (r?.state === 'failed') return 'I got stuck on the first pass. Open it to see why.'
  if (r?.line) return r.line
  if (i.tasks?.line) return i.tasks.line
  if (i.junior?.stage === 'watching') return i.reason === 'your-pr' ? 'Babysitting. Nothing to do right now.' : 'Watching for changes.'
  if (i.junior?.stage === 'handed-in') return i.tasks?.lastDone ?? 'Done for now.'
  if (i.suggestion) return `${i.suggestion.head}. ${i.suggestion.would}`
  return 'Not handed to me. Nothing starts until you hand it off.'
}

/**
 * One verb at a time, its error in a line under the list. Keeps each
 * hand-off's answer, so a PR handed off with its watch off reads "off" before
 * the refetch lands. `turnOn` flips a watch on; `onTurnedOn` gets the row.
 */
function useAct(onTurnedOn: (id: string) => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [answered, setAnswered] = useState<Readonly<Record<string, HandoffReadiness>>>({})
  const [turning, setTurning] = useState<WatchId | null>(null)
  const act: Act = (verb, id, playbook) => {
    setBusy(id)
    setError(null)
    void sendHandoff(verb, id, playbook).then(({ error, readiness }) => {
      setBusy(null)
      setError(error)
      if (verb === 'start' && readiness) setAnswered((a) => ({ ...a, [id]: readiness }))
    })
  }
  const turnOn: TurnOn = (watch, id) => {
    setTurning(watch)
    setError(null)
    void turnOnWatch(watch).then((err) => {
      setTurning(null)
      if (err) return setError(`${WATCH_STILL_OFF[watch]} ${err}`)
      setAnswered((a) => Object.fromEntries(Object.entries(a).filter(([, r]) => !(r.state === 'watch-off' && r.watch === watch))))
      onTurnedOn(id)
    })
  }
  return { busy, error, act, answered, turning, turnOn }
}

const Kbd = ({ children }: { children: ReactNode }) => <kbd className="jhKbd">{children}</kbd>

type Props = Nav & {
  tab: LedgerTab
  items: ScoredItem[]
  /** what Junior is held on, outside any item: Needs you puts it first */
  needs: NeedsRow[]
  /** your gh login: your own items read "You" */
  me: string | null
  /** what the tab says when it has nothing */
  empty: string
}

export function JuniorLedger({ tab, items, needs, me, empty, onNavigate }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  // the Turn on button leaves once its row is ready: give focus to the row itself, unless it went elsewhere
  const focusRow = (id: string) =>
    requestAnimationFrame(() => {
      const row = [...(listRef.current?.querySelectorAll<HTMLElement>('.jhItem') ?? [])].find((el) => el.dataset.key === id)
      const a = document.activeElement
      if (!a || a === document.body || row?.contains(a)) row?.querySelector<HTMLElement>('.jhRow')?.focus()
    })
  const { busy, error, act, answered, turning, turnOn } = useAct(focusRow)
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = tab === 'needs' ? needs.map((n) => ({ key: `need:${n.key}`, group: 'waiting' as const, need: n })) : []
    for (const i of ledgerRows(items.map((i) => withAnswer(i, answered)), tab)) out.push({ key: i.id, group: ledgerGroup(i), item: i })
    return out
  }, [items, needs, tab, answered])
  // Up next folds its long FYI tail into a link to the inbox.
  const fyiAll = tab === 'up' ? lines.filter((l) => l.group === 'fyi').length : 0
  const firstFyi = lines.findIndex((l) => l.group === 'fyi')
  const shown = fyiAll > FYI_SHOWN ? lines.filter((l, n) => l.group !== 'fyi' || n - firstFyi < FYI_SHOWN) : lines
  const fyi = Math.max(0, fyiAll - FYI_SHOWN)

  // the keyboard cursor: none until you press J or K, or click a row
  const [sel, setSel] = useState<number | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [snoozing, setSnoozing] = useState<string | null>(null)
  const at = sel === null ? null : Math.min(sel, Math.max(0, shown.length - 1))

  // "Not useful": one notice at a time, in the marked row's slot
  const [gone, setGone] = useState<Gone | null>(null)
  const [held, setHeld] = useState({ hover: false, focus: false })
  const [nuError, setNuError] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const phone = useIsMobile()
  const emptyRef = useRef<HTMLParagraphElement>(null)
  /** the row Undo brought back: the cursor and focus go to it once it renders */
  const restoring = useRef<string | null>(null)
  /** the notice expired holding focus: give it to the row now in its slot */
  const refocusAt = useRef<number | null>(null)
  /** our own move of focus to Undo after a click doesn't hold the timer; a person's does */
  const autoFocused = useRef(false)
  const rowEl = (key: string) => [...(listRef.current?.querySelectorAll<HTMLElement>('.jhItem') ?? [])].find((el) => el.dataset.key === key)

  const markGone = (item: ScoredItem, index: number, how: 'key' | 'click') => {
    const focusInside = !!rowEl(item.id)?.contains(document.activeElement)
    const marking = markNotUseful(item)
    setGone({ item, at: index, wasOpen: open.has(item.id), leaving: false, markedAt: Date.now(), marking })
    setHeld({ hover: false, focus: false })
    setNuError(null)
    setOpen((o) => {
      const n = new Set(o)
      n.delete(item.id)
      return n
    })
    setSaid(`Marked not useful: ${item.title}. ${isMobile() ? 'Tap Undo within 5 seconds.' : 'Press U or Undo within 5 seconds.'}`)
    const focusUndo = () => {
      const undo = listRef.current?.querySelector<HTMLElement>('.jhGone .undo')
      if (!undo) return
      autoFocused.current = true
      undo.focus()
    }
    // The clicked button is gone: focus goes to Undo, never to body. A key press keeps
    // focus off Undo, so the next Space or Enter can't take the mark back: if focus was
    // in the marked row, it goes to the row now in the slot (where the cursor is). U undoes.
    if (how === 'click') requestAnimationFrame(focusUndo)
    else if (focusInside)
      requestAnimationFrame(() => {
        const rows = listRef.current?.querySelectorAll<HTMLElement>('.jhItem > .jhRow')
        const row = rows?.length ? rows[Math.min(index, rows.length - 1)] : null
        // nothing left but the notice: Undo is the only place focus can go
        if (row) row.focus()
        else focusUndo()
      })
    void marking.then((err) => {
      if (!err) return
      setGone((g) => (g?.item.id === item.id ? null : g))
      setNuError(`Couldn’t mark it not useful. ${err}`)
    })
  }

  const undoGone = () => {
    const g = live.current.notice
    if (!g) return
    setGone(null)
    if (g.wasOpen) setOpen((o) => new Set(o).add(g.item.id))
    restoring.current = g.item.id
    setSaid(`Back on Needs you: ${g.item.title}.`)
    void undoNotUseful(g.item, g.marking).then((err) => {
      if (!err) return
      // the row leaves again: a later return mustn't pull the cursor or focus to it
      if (restoring.current === g.item.id) restoring.current = null
      setNuError(`Couldn’t undo. ${err}`)
    })
  }

  const hold = (what: 'hover' | 'focus', on: boolean) => {
    if (what === 'focus' && on && autoFocused.current) {
      autoFocused.current = false
      return
    }
    setHeld((h) => (h[what] === on ? h : { ...h, [what]: on }))
  }

  // 5 s, paused while hovered or focused (WCAG 2.2.1); leaving restarts the full 5 s. The hold
  // ends NOT_USEFUL_HOLD_MAX_MS after the mark, inside the server's undo window: an Undo you can
  // see is always one the server still takes.
  useEffect(() => {
    if (!gone || gone.leaving) return
    const cap = gone.markedAt + NOT_USEFUL_HOLD_MAX_MS - Date.now()
    const wait = held.hover || held.focus ? cap : Math.min(NOT_USEFUL_NOTICE_MS, cap)
    const t = setTimeout(() => setGone((g) => g && { ...g, leaving: true }), Math.max(0, wait))
    return () => clearTimeout(t)
  }, [gone, held])
  useEffect(() => {
    if (!gone?.leaving) return
    const t = setTimeout(() => {
      if (listRef.current?.querySelector('.jhGone')?.contains(document.activeElement)) refocusAt.current = gone.at
      setGone(null)
    }, GONE_OUT_MS)
    return () => clearTimeout(t)
  }, [gone])
  // after Undo: the cursor and focus on the restored row; after expiry: focus on the row in the slot
  useEffect(() => {
    const id = restoring.current
    if (id) {
      const n = shown.findIndex((l) => l.key === id)
      if (n >= 0) {
        restoring.current = null
        setSel(n)
        requestAnimationFrame(() => rowEl(id)?.querySelector<HTMLElement>('.jhRow')?.focus())
      }
    }
    if (refocusAt.current !== null && !gone) {
      const rows = listRef.current?.querySelectorAll<HTMLElement>('.jhItem > .jhRow')
      const n = refocusAt.current
      refocusAt.current = null
      ;(rows?.length ? rows[Math.min(n, rows.length - 1)] : emptyRef.current)?.focus()
    }
  })

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const openItem = (id: string) => onNavigate(itemHash(id))
  const goNeed = (n: NeedsRow) => onNavigate(n.target.kind === 'session' ? n.target.id : '/junior/log')

  // the notice shows only while its row is off the list (a refetch can bring the row back early)
  const notice = gone && !lines.some((l) => l.key === gone.item.id) ? gone : null

  // The keys: only while nothing else wants them (a text box, a menu, a `g` sequence).
  const live = useRef({ shown, at, open, act, turnOn, onNavigate, tab, notice, markGone, undoGone })
  live.current = { shown, at, open, act, turnOn, onNavigate, tab, notice, markGone, undoGone }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e) || isGoSequence(e) || anyDialogOpen()) return
      const { shown, at, open, act, turnOn, onNavigate } = live.current
      const line = at === null ? undefined : shown[at]
      // a focused button or link answers Space and Enter itself
      if ((e.key === ' ' || e.key === 'Enter') && (e.target as HTMLElement | null)?.closest?.('button, a, [role="menuitem"]')) return
      const openItem = (id: string) => onNavigate(itemHash(id))
      const goNeed = (n: NeedsRow) => onNavigate(n.target.kind === 'session' ? n.target.id : '/junior/log')
      const move = (to: number) => {
        e.preventDefault()
        setSel(to)
        requestAnimationFrame(() => listRef.current?.querySelector('.jhItem.focus')?.scrollIntoView({ block: 'nearest' }))
      }
      if (e.key === 'j' || e.key === 'ArrowDown') return move(at === null ? 0 : Math.min(shown.length - 1, at + 1))
      if (e.key === 'k' || e.key === 'ArrowUp') return move(at === null ? 0 : Math.max(0, at - 1))
      if (e.key === 'Escape') {
        // close everything, and put the cursor away
        if (open.size) setOpen(new Set())
        setSel(null)
        return
      }
      if (!line) return
      if (e.key === ' ') {
        e.preventDefault()
        return toggle(line.key)
      }
      // the rest act on an open row only
      if (!open.has(line.key)) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (line.need) return goNeed(line.need)
        return primaryOf(line.item, act, () => openItem(line.item.id), turnOn).run()
      }
      if (!line.item) return
      if (e.key === 'o') return openItem(line.item.id)
      if (e.key === 's') {
        e.preventDefault()
        return setSnoozing(line.key)
      }
      if (e.key === 'd') return void doneItem(line.item)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // N and U in the capture phase: N must win over the app's "n" (new chat), which stands aside on
  // a prevented event. N only marks an open item row on Needs you; anywhere else "n" is a new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'u') return
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e) || isGoSequence(e) || anyDialogOpen()) return
      const { shown, at, open, tab, notice, markGone, undoGone } = live.current
      if (e.key === 'u') {
        // only while you can see the notice's Undo
        if (!notice) return
        e.preventDefault()
        return undoGone()
      }
      const line = at === null ? undefined : shown[at]
      if (tab !== 'needs' || !line?.item || !open.has(line.key)) return
      e.preventDefault()
      markGone(line.item, at!, 'key')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])

  const goneLine = notice && <GoneLine key={`gone:${notice.item.id}`} title={notice.item.title} leaving={notice.leaving} phone={phone} onUndo={undoGone} onHold={hold} />
  const noticeAt = notice ? Math.min(notice.at, shown.length) : -1

  if (lines.length === 0 && !notice)
    return (
      <p className="jhEmpty" ref={emptyRef} tabIndex={-1}>
        <JuniorFace mood="hello" size={18} motion="still" decorative /> {empty}
      </p>
    )

  let lastGroup: LedgerGroup | null = null
  return (
    <div className="jhList" ref={listRef}>
      {shown.map((line, n) => {
        const head =
          tab === 'up' && line.group !== lastGroup ? (
            <div className="jhGrp">
              <b>{LEDGER_GROUP_TITLE[line.group]}</b>
              <span className="n">{lines.filter((l) => l.group === line.group).length}</span>
            </div>
          ) : null
        lastGroup = line.group
        const isOpen = open.has(line.key)
        const focus = n === at
        const click = () => {
          setSel(n)
          toggle(line.key)
        }
        return (
          <Fragment key={line.key}>
            {n === noticeAt && goneLine}
            {head}
            <div className={`jhItem${isOpen ? ' open' : ''}${focus ? ' focus' : ''}`} data-key={line.key}>
              {line.need ? (
                <NeedLine need={line.need} open={isOpen} onClick={click} onGo={() => goNeed(line.need)} />
              ) : (
                <ItemLine
                  item={line.item}
                  me={me}
                  open={isOpen}
                  busy={busy === line.item.id}
                  turning={turning}
                  turnOn={turnOn}
                  snoozing={snoozing === line.key}
                  onSnoozing={(o) => setSnoozing(o ? line.key : null)}
                  onClick={click}
                  act={act}
                  onOpen={() => openItem(line.item.id)}
                  onNotUseful={tab === 'needs' ? () => markGone(line.item, n, 'click') : undefined}
                />
              )}
            </div>
          </Fragment>
        )
      })}
      {noticeAt === shown.length && goneLine}
      {fyi > 0 && (
        <button type="button" className="jhMore" onClick={() => onNavigate('/inbox')}>
          {fyi} more for your info in the inbox
        </button>
      )}
      {(nuError ?? error) && (
        <p className="jrErr" role="alert">
          {nuError ?? error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      <div className="jhKeys" aria-hidden="true">
        <span>
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>move
        </span>
        <span>
          <Kbd>Space</Kbd>open or close
        </span>
        <span>
          <Kbd>⏎</Kbd>do it
        </span>
        <span>
          <Kbd>Esc</Kbd>close all
        </span>
      </div>
    </div>
  )
}

const Chev = () => <ChevronRight className="chev" size={14} aria-hidden="true" />

function ItemLine({
  item: i,
  me,
  open,
  busy,
  turning,
  turnOn,
  snoozing,
  onSnoozing,
  onClick,
  act,
  onOpen,
  onNotUseful,
}: {
  item: ScoredItem
  me: string | null
  open: boolean
  busy: boolean
  /** the watch a Turn on is switching on right now */
  turning: WatchId | null
  turnOn: TurnOn
  snoozing: boolean
  onSnoozing: (open: boolean) => void
  onClick: () => void
  act: Act
  onOpen: () => void
  /** Needs you only: "not useful", it shouldn't have reached you */
  onNotUseful?: () => void
}) {
  const who = whoOf(i, me)
  const Icon = kindIcon(i)
  const st = juniorState(i)
  const p = ledgerProgress(i)
  const hot = ageHot(i)
  const primary = primaryOf(i, act, onOpen, turnOn)
  const capId = `jhCap-${i.id}`
  return (
    <>
      <button type="button" className="jhRow" aria-expanded={open} onClick={onClick}>
        <span className={`wc${who === 'You' ? ' you' : ''}`}>
          {who === 'Junior' ? <JuniorFace mood="hello" size={20} motion="still" decorative /> : who !== 'You' && <span className="av">{initials(who)}</span>}
          <span className="nm">{who}</span>
        </span>
        <span className="tt">{i.title}</span>
        {p !== null ? (
          <span className="prog" role="progressbar" aria-label="How far Junior is" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p * 100)}>
            <i style={{ width: `${Math.round(p * 100)}%` }} />
          </span>
        ) : (
          <span className={`jrc${st.quiet ? ' quiet' : ''}`}>{st.text}</span>
        )}
        <span className="wh">
          {refOf(i) && (
            <>
              <Icon size={13} aria-hidden="true" />
              <span>{refOf(i)}</span>
            </>
          )}
        </span>
        <span className={`ag${hot ? ' hot' : ''}`}>{shortAge(i.updatedAt)}</span>
        <Chev />
      </button>
      {open && (
        <div className="jhXp">
          <span className="lbl">{i.source === 'slack' ? 'Message' : 'Context'}</span>
          <span className="ctx">{contextOf(i)}</span>
          <span className="lbl jr">Junior</span>
          <span className="said">{juniorSays(i)}</span>
          <div className="acts">
            {primary.watch ? (
              <>
                <TurnOnButton watch={primary.watch} busy={turning === primary.watch} onClick={primary.run} className="btn sm primary" capId={capId}>
                  {primary.label} <Kbd>⏎</Kbd>
                </TurnOnButton>
                <WatchCap watch={primary.watch} id={capId} />
                <button type="button" className="btn sm" disabled={busy} onClick={() => act('pause', i.id)}>
                  Pause
                </button>
              </>
            ) : (
              <button type="button" className="btn sm primary" disabled={busy} onClick={primary.run}>
                {primary.label} <Kbd>⏎</Kbd>
              </button>
            )}
            {primary.run !== onOpen && (
              <button type="button" className="btn sm" onClick={onOpen}>
                Open <Kbd>O</Kbd>
              </button>
            )}
            {i.suggestion && (
              <button type="button" className="btn sm ghost" disabled={busy} title="Not this one" onClick={() => act('not-now', i.id)}>
                <X size={13} aria-hidden="true" /> Not this one
              </button>
            )}
            {onNotUseful && (
              // the key strip is hidden on a phone: there this is the way in
              <button type="button" className="btn sm ghost nuPhone" aria-label="Not useful: this didn’t need you" onClick={onNotUseful}>
                Not useful
              </button>
            )}
            <span className="keys">
              <SnoozeMenu open={snoozing} onOpenChange={onSnoozing} onSnooze={(until) => void snoozeItem(i, until)}>
                <button type="button" className="jhKey">
                  <Kbd>S</Kbd>snooze
                </button>
              </SnoozeMenu>
              <button type="button" className="jhKey" onClick={() => void doneItem(i)}>
                <Kbd>D</Kbd>done
              </button>
              {onNotUseful && (
                <button type="button" className="jhKey" aria-keyshortcuts="n" title="This didn’t need you. It leaves Needs you until something new happens." onClick={onNotUseful}>
                  <Kbd>N</Kbd>not useful
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </>
  )
}

/**
 * "Marked not useful · Undo", in the marked row's slot for 5 s. A ledger line,
 * quieter than a row: no card, no colour. Hover or focus holds it.
 */
function GoneLine({
  title,
  leaving,
  phone,
  onUndo,
  onHold,
}: {
  title: string
  leaving: boolean
  /** on a phone Undo is the card's own `btn sm`, with no key */
  phone: boolean
  onUndo: () => void
  onHold: (what: 'hover' | 'focus', on: boolean) => void
}) {
  return (
    <div
      className={`jhGone${leaving ? ' out' : ''}`}
      onMouseEnter={() => onHold('hover', true)}
      onMouseLeave={() => onHold('hover', false)}
      onFocus={() => onHold('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onHold('focus', false)
      }}
    >
      <span className="w">Marked not useful</span>
      <span className="sep" aria-hidden="true">
        ·
      </span>
      {phone ? (
        <button type="button" className="btn sm undo" onClick={onUndo}>
          Undo
        </button>
      ) : (
        <button type="button" className="jhKey undo" aria-keyshortcuts="u" onClick={onUndo}>
          Undo <Kbd>U</Kbd>
        </button>
      )}
      <span className="tt">{title}</span>
    </div>
  )
}

/** Something Junior is held on that isn't an item: a blocked chat, a plan or a gate, sends to OK. */
function NeedLine({ need, open, onClick, onGo }: { need: NeedsRow; open: boolean; onClick: () => void; onGo: () => void }) {
  return (
    <>
      <button type="button" className="jhRow" aria-expanded={open} onClick={onClick}>
        <span className="wc">
          <JuniorFace mood="needs" size={20} motion="still" decorative />
          <span className="nm">Junior</span>
        </span>
        <span className="tt">{need.title}</span>
        <span className="jrc">Paused on you</span>
        <span className="wh">
          <span>{need.meta}</span>
        </span>
        <span className="ag">{need.right}</span>
        <Chev />
      </button>
      {open && (
        <div className="jhXp">
          <span className="lbl">Context</span>
          <span className="ctx">{need.meta}</span>
          <span className="lbl jr">Junior</span>
          <span className="said">{need.kind === 'sends' ? 'These wait for your OK. Nothing goes out until you say so.' : 'I stopped here and need you before I go on.'}</span>
          <div className="acts">
            <button type="button" className="btn sm primary" onClick={onGo}>
              {need.go} <Kbd>⏎</Kbd>
            </button>
          </div>
        </div>
      )}
    </>
  )
}
