/**
 * The Junior page's list, the Ledger (.docs/junior-goals-teams/junior-home-list.html,
 * artifact 065cfb8a v7). One line per row: who · title · Junior's state in sky
 * · where · age (orange only when a person waits) · chevron. Rows start
 * closed; a click or Space opens one as a bordered card, its Message or
 * Context, what Junior says and the actions aligned to the row's columns.
 * Many can be open; Esc closes all. J/K move, ⏎ acts on an open row only,
 * S snoozes, D marks done, O opens the item.
 *
 * Which rows a tab shows and the words on them are core/junior/ledger.ts.
 * Every verb here is local or a hand-off; sends stay held for approval.
 */
import { ChevronRight, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { NeedsRow, ScoredItem } from '../../../shared/protocol.js'
import { juniorState, LEDGER_GROUP_TITLE, ledgerGroup, ledgerProgress, ledgerRows, personWaits, type LedgerGroup, type LedgerTab } from '../../../core/junior/ledger.js'
import { itemHash } from '../hooks.js'
import { doneItem, handoff, snoozeItem, VERB, type HandoffVerb } from '../handoff.js'
import { anyDialogOpen, isGoSequence, isTypingTarget } from '../keys.js'
import { kindIcon, shortAge } from '../itemUi.js'
import { JuniorFace } from './JuniorFace.js'
import { SnoozeMenu } from './SnoozeMenu.js'

type Nav = { onNavigate: (hash: string) => void }

/** FYI rows shown on Up next before "more in your inbox". */
const FYI_SHOWN = 6

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

/** The one verb ⏎ does on an open row. */
type Primary = { label: string; run: () => void }

function primaryOf(i: ScoredItem, act: (verb: HandoffVerb, id: string, playbook?: string) => void, open: () => void): Primary {
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

/** One verb at a time, its error in a line under the list. */
function useAct() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const act = (verb: HandoffVerb, id: string, playbook?: string) => {
    setBusy(id)
    setError(null)
    void handoff(verb, id, playbook).then((err) => {
      setBusy(null)
      setError(err)
    })
  }
  return { busy, error, act }
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
  const { busy, error, act } = useAct()
  const lines = useMemo<Line[]>(() => {
    const out: Line[] = tab === 'needs' ? needs.map((n) => ({ key: `need:${n.key}`, group: 'waiting' as const, need: n })) : []
    for (const i of ledgerRows(items, tab)) out.push({ key: i.id, group: ledgerGroup(i), item: i })
    return out
  }, [items, needs, tab])
  // Up next folds its long FYI tail into a link to the inbox.
  const fyiAll = tab === 'up' ? lines.filter((l) => l.group === 'fyi').length : 0
  const firstFyi = lines.findIndex((l) => l.group === 'fyi')
  const shown = fyiAll > FYI_SHOWN ? lines.filter((l, n) => l.group !== 'fyi' || n - firstFyi < FYI_SHOWN) : lines
  const fyi = Math.max(0, fyiAll - FYI_SHOWN)

  // the keyboard cursor: none until you press J or K, or click a row
  const [sel, setSel] = useState<number | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [snoozing, setSnoozing] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const at = sel === null ? null : Math.min(sel, Math.max(0, shown.length - 1))

  const toggle = (key: string) =>
    setOpen((o) => {
      const n = new Set(o)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const openItem = (id: string) => onNavigate(itemHash(id))
  const goNeed = (n: NeedsRow) => onNavigate(n.target.kind === 'session' ? n.target.id : '/junior/log')

  // The keys: only while nothing else wants them (a text box, a menu, a `g` sequence).
  const live = useRef({ shown, at, open, act, onNavigate })
  live.current = { shown, at, open, act, onNavigate }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e) || isGoSequence(e) || anyDialogOpen()) return
      const { shown, at, open, act, onNavigate } = live.current
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
        return primaryOf(line.item, act, () => openItem(line.item.id)).run()
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

  if (lines.length === 0)
    return (
      <p className="jhEmpty">
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
            {head}
            <div className={`jhItem${isOpen ? ' open' : ''}${focus ? ' focus' : ''}`}>
              {line.need ? (
                <NeedLine need={line.need} open={isOpen} onClick={click} onGo={() => goNeed(line.need)} />
              ) : (
                <ItemLine
                  item={line.item}
                  me={me}
                  open={isOpen}
                  busy={busy === line.item.id}
                  snoozing={snoozing === line.key}
                  onSnoozing={(o) => setSnoozing(o ? line.key : null)}
                  onClick={click}
                  act={act}
                  onOpen={() => openItem(line.item.id)}
                />
              )}
            </div>
          </Fragment>
        )
      })}
      {fyi > 0 && (
        <button type="button" className="jhMore" onClick={() => onNavigate('/inbox')}>
          {fyi} more for your info in the inbox
        </button>
      )}
      {error && (
        <p className="jrErr" role="alert">
          {error}
        </p>
      )}
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
  snoozing,
  onSnoozing,
  onClick,
  act,
  onOpen,
}: {
  item: ScoredItem
  me: string | null
  open: boolean
  busy: boolean
  snoozing: boolean
  onSnoozing: (open: boolean) => void
  onClick: () => void
  act: (verb: HandoffVerb, id: string, playbook?: string) => void
  onOpen: () => void
}) {
  const who = whoOf(i, me)
  const Icon = kindIcon(i)
  const st = juniorState(i)
  const p = ledgerProgress(i)
  const hot = personWaits(i) && ledgerGroup(i) === 'waiting'
  const primary = primaryOf(i, act, onOpen)
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
            <button type="button" className="btn sm primary" disabled={busy} onClick={primary.run}>
              {primary.label} <Kbd>⏎</Kbd>
            </button>
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
            <span className="keys">
              <SnoozeMenu open={snoozing} onOpenChange={onSnoozing} onSnooze={(until) => void snoozeItem(i, until)}>
                <button type="button" className="jhKey">
                  <Kbd>S</Kbd>snooze
                </button>
              </SnoozeMenu>
              <button type="button" className="jhKey" onClick={() => void doneItem(i)}>
                <Kbd>D</Kbd>done
              </button>
            </span>
          </div>
        </div>
      )}
    </>
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
