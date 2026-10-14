/**
 * Actions (.docs/action-card-variations.html, P3 "Split: list + detail"):
 * everything sessions did — or want to do — that leaves this machine. Tabs
 * Needs you · Scheduled · Sent · Stopped; a dense list on the left, the
 * selected action's stub card on the right, where a queued one is approved,
 * edited, sent back or rejected. The keyboard clears the queue: J/K move,
 * A approve, E edit, B send back, R reject, U undo, Enter open, O open the
 * link, S open the session.
 *
 * On a phone it is the list alone; a tap opens the card as a sheet.
 *
 * The row menu's "Not an action" writes the workspace's actions file; set-aside
 * rows live under their own tab, where "This is an action" brings them back.
 */
import * as Dialog from '@radix-ui/react-dialog'
import { EyeOff, MoreHorizontal, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ACTION_TABS, TAB_LABEL, tabOf, type ActionTab } from '../../../core/actions/view.js'
import type { ActionView } from '../../../shared/protocol.js'
import { actOn, KIND_ICON, originText, overrideAction, STATUS_TEXT, useActions } from '../actions.js'
import { itemHash } from '../hooks.js'
import { shortAge } from '../itemUi.js'
import { useIsMobile } from '../useMobile.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { ActionCard, type CardCommand } from './ActionCard.js'

type Tab = ActionTab | 'aside'

/** The dot's colour on a row: the one colour it carries. */
const DOT: Record<ActionView['status'], string> = {
  succeeded: 'green',
  attempted: 'live',
  failed: 'red',
  denied: 'off',
  needs_you: 'yellow',
  scheduled: 'live',
  sending: 'live',
  unknown: 'orange',
  sent_back: 'off',
  rejected: 'off',
  expired: 'off',
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The row's second line: where it came from, and what stopped it. */
function subText(a: ActionView): string {
  const origin = originText(a)
  if (a.status === 'succeeded') return a.count > 1 ? `${origin} · ×${a.count}` : origin
  if (a.status === 'needs_you') return `${origin} · #${a.short}`
  if (a.error && (a.status === 'failed' || a.status === 'denied')) return `${origin} · ${clip(a.error, 60)}`
  return `${origin} · ${STATUS_TEXT[a.status]}`
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

export function ActionsPage({ onNavigate }: { onNavigate: (hash: string) => void }) {
  const { actions, today, file, loaded, error, refresh } = useActions({})
  const mobile = useIsMobile()
  const [tab, setTab] = useState<Tab | null>(null)
  const [filter, setFilter] = useState('')
  const [failed, setFailed] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [sheet, setSheet] = useState<string | null>(null)
  const [command, setCommand] = useState<CardCommand | undefined>(undefined)
  const listRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const sheetClose = useRef<HTMLButtonElement>(null)

  const shown = useMemo(() => actions.filter((a) => !a.hidden), [actions])
  const aside = actions.length - shown.length
  const counts = useMemo(() => {
    const c: Record<ActionTab, number> = { needs_you: 0, scheduled: 0, sent: 0, stopped: 0 }
    for (const a of shown) c[tabOf(a.status)] += 1
    return c
  }, [shown])
  // First visit: whatever needs you, else what went out.
  const active: Tab = tab ?? (counts.needs_you ? 'needs_you' : counts.scheduled ? 'scheduled' : 'sent')
  const q = filter.trim().toLowerCase()
  const rows = useMemo(
    () =>
      (active === 'aside' ? actions.filter((a) => a.hidden) : shown.filter((a) => tabOf(a.status) === active)).filter(
        (a) => !q || [a.title, a.summary, a.tool, a.sessionTitle, a.jobTitle, a.itemTitle, a.link, a.short].some((s) => s?.toLowerCase().includes(q)),
      ),
    [actions, shown, active, q],
  )
  const current = rows.find((a) => a.id === selected) ?? (mobile ? undefined : rows[0])
  const sheetAction = sheet ? actions.find((a) => a.id === sheet) : undefined

  // Keep the selection on the list as it changes under it.
  useEffect(() => {
    if (!mobile && rows.length && !rows.some((a) => a.id === selected)) setSelected(rows[0].id)
  }, [rows, selected, mobile])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current?.id])

  async function override(a: ActionView, verdict: 'action' | 'not_action') {
    setFailed(null)
    const err = await overrideAction(a.id, verdict)
    if (err) setFailed(err)
    refresh()
  }

  async function verb(v: 'approve' | 'undo', a: ActionView) {
    setFailed(null)
    const r = await actOn(v, a.id)
    if (!r.ok) setFailed(r.error)
  }

  // The keyboard: the page's, unless you're typing or a menu/dialog has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
      if ((e.target as HTMLElement | null)?.closest?.('[role="menu"], [role="dialog"]') && e.key !== 'Escape') return
      const i = current ? rows.findIndex((a) => a.id === current.id) : -1
      const pick = (n: number) => {
        const next = rows[Math.max(0, Math.min(rows.length - 1, n))]
        if (next) setSelected(next.id)
      }
      const a = mobile ? sheetAction : current
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          pick(i + 1)
          break
        case 'k':
        case 'ArrowUp':
          pick(i - 1)
          break
        case 'a':
          if (a?.status === 'needs_you') void verb('approve', a)
          break
        case 'u':
          if (a?.status === 'scheduled') void verb('undo', a)
          break
        case 'e':
        case 'r':
        case 'b':
          if (a?.status !== 'needs_you') return
          setCommand((c) => ({ kind: e.key === 'e' ? 'edit' : e.key === 'r' ? 'reject' : 'send_back', n: (c?.n ?? 0) + 1 }))
          break
        case 'Enter':
          if (!current) return
          if (mobile) setSheet(current.id)
          // The detail pane itself, never a button in it: a second Enter must not approve.
          else detailRef.current?.focus()
          break
        case 'o':
          if (a?.link) window.open(a.link, '_blank', 'noopener')
          break
        case 's':
          if (a) onNavigate(a.sessionId)
          break
        default:
          return
      }
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, current, sheetAction, mobile])

  const detail = (a: ActionView) => (
    <ActionCard
      key={a.id}
      a={a}
      pinnedOpen
      command={command}
      onNavigate={onNavigate}
      footer={
        <dl className="akv more">
          <dt>drafted in</dt>
          <dd>
            <button type="button" className="alink" onClick={() => onNavigate(a.sessionId)}>
              {a.sessionTitle ?? 'open the session'} →
            </button>
          </dd>
          {a.itemId && (
            <>
              <dt>item</dt>
              <dd>
                <button type="button" className="alink" onClick={() => onNavigate(itemHash(a.itemId!))}>
                  {a.itemTitle ?? a.itemId} →
                </button>
              </dd>
            </>
          )}
          <dt>counted</dt>
          <dd>
            {a.counted} ·{' '}
            <button type="button" className="alink mute" onClick={() => void override(a, a.hidden ? 'action' : 'not_action')}>
              {a.hidden ? 'this is an action' : 'not an action?'}
            </button>
          </dd>
        </dl>
      }
    />
  )

  return (
    <div id="actionsPage" className="page full">
      <div className="glow blue" aria-hidden="true" />
      <div className="inner">
        <div className="jobHead actHead">
          <div className="actTitle">
            <h1 className="display">Actions</h1>
            {today && <p className="actToday">{today.line}</p>}
          </div>
          <input className="filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter actions…" aria-label="Filter actions" />
        </div>

        <div className="seg wrap actSeg" role="tablist" aria-label="Actions">
          {ACTION_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={active === t}
              className={`segBtn${active === t ? ' active' : ''}${t === 'needs_you' && counts.needs_you ? ' need' : ''}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
              <span className="segN">{counts[t]}</span>
            </button>
          ))}
          {aside > 0 && (
            <button
              type="button"
              role="tab"
              aria-selected={active === 'aside'}
              className={`segBtn${active === 'aside' ? ' active' : ''}`}
              title="Calls you marked “Not an action” — kept, but off the list"
              onClick={() => setTab('aside')}
            >
              Set aside<span className="segN">{aside}</span>
            </button>
          )}
        </div>

        {file && file.errors.length > 0 && (
          <div className="notice actFileErr" title={file.errors.join('\n')}>
            {file.path.split('/').pop()} has {file.errors.length === 1 ? 'an error' : `${file.errors.length} errors`} — the defaults apply until it's fixed: {file.errors[0]}
          </div>
        )}
        {failed && <div className="msg error">{failed}</div>}
        {error && <div className="msg error">{error}</div>}

        {!loaded ? (
          <div className="probing">
            <span className="pip" /> Loading actions…
          </div>
        ) : rows.length === 0 ? (
          <div className="actEmpty">
            {actions.length === 0
              ? 'Nothing has left this machine yet. When a session opens a PR, comments, files a ticket or pushes, it lands here — and when a job or a team wants to, it waits here for you.'
              : q
                ? 'Nothing here matches.'
                : active === 'needs_you'
                  ? 'Nothing waits on you. Jobs and team runs queue their outbound calls here for approval.'
                  : active === 'scheduled'
                    ? 'Nothing is about to go out.'
                    : 'Nothing here.'}
          </div>
        ) : (
          <div className="asplit">
            <div className="ls" ref={listRef} role="listbox" aria-label={TAB_LABEL[active === 'aside' ? 'stopped' : active]}>
              {rows.map((a) => {
                const Icon = KIND_ICON[a.kind]
                const sel = !mobile && current?.id === a.id
                return (
                  <div
                    key={a.id}
                    role="option"
                    aria-selected={sel}
                    tabIndex={-1}
                    className={`ali st-${a.status}${sel ? ' sel' : ''}`}
                    onClick={() => (mobile ? setSheet(a.id) : setSelected(a.id))}
                  >
                    <span className={`dot ${DOT[a.status]}`} aria-hidden="true" />
                    <Icon size={14} className="ic" aria-hidden="true" />
                    <div className="s">
                      <b>{a.title}</b>
                      <span>{subText(a)}</span>
                    </div>
                    <span className="t mono" title={new Date(a.attemptedAt).toLocaleString()}>
                      {shortAge(a.attemptedAt)}
                    </span>
                    {a.hidden && (
                      <Menu>
                        <MenuTrigger asChild>
                          <button type="button" className="iconBtn sm" aria-label={`More for ${a.title}`} onClick={(e) => e.stopPropagation()}>
                            <MoreHorizontal size={14} aria-hidden="true" />
                          </button>
                        </MenuTrigger>
                        <MenuContent align="end" className="rowMenu">
                          <MenuItem onSelect={() => void override(a, 'action')}>
                            <Undo2 size={13} aria-hidden="true" /> This is an action
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                )
              })}
            </div>
            {!mobile && (
              <div className="dt" ref={detailRef} tabIndex={-1} aria-label="The selected action">
                {current ? detail(current) : null}
                <div className="keys mono">
                  <kbd>J</kbd>
                  <kbd>K</kbd> move
                  {current?.status === 'needs_you' && (
                    <>
                      <kbd>A</kbd> approve <kbd>E</kbd> edit <kbd>B</kbd> send back <kbd>R</kbd> reject
                    </>
                  )}
                  {current?.status === 'scheduled' && (
                    <>
                      <kbd>U</kbd> undo
                    </>
                  )}
                  {current?.link && (
                    <>
                      <kbd>O</kbd> open link
                    </>
                  )}
                  <kbd>S</kbd> session
                </div>
              </div>
            )}
          </div>
        )}

        {file && (
          <div className="wtblFoot">
            <span className="mono" title={file.path}>
              {file.path.split('/').pop()}
            </span>
            <span style={{ marginLeft: 'auto' }}>
              <EyeOff size={12} aria-hidden="true" style={{ verticalAlign: '-2px', marginRight: 6 }} />
              What counts lives in that file: the outbound commands, and every override.
            </span>
          </div>
        )}
      </div>

      {/* Phone: the card as a sheet. */}
      <Dialog.Root open={mobile && !!sheetAction} onOpenChange={(o) => !o && setSheet(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="projOverlay" />
          <Dialog.Content
            asChild
            aria-describedby={undefined}
            // Never land on Approve: a stray Enter would send a message to a person.
            onOpenAutoFocus={(e) => {
              e.preventDefault()
              sheetClose.current?.focus({ preventScroll: true })
            }}
          >
            <dialog open className="actSheet">
              <Dialog.Title className="sr-only">{sheetAction?.title ?? 'Action'}</Dialog.Title>
              {sheetAction && detail(sheetAction)}
              <Dialog.Close asChild>
                <button ref={sheetClose} type="button" className="btn wide outline">
                  Close
                </button>
              </Dialog.Close>
            </dialog>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  )
}
