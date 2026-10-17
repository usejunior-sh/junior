import { MessageCircleQuestion, ShieldQuestion, AlertTriangle, CheckSquare, Square, Sparkles, Check, AlarmClock, MoreHorizontal, ChevronRight, ExternalLink, Play, Target, CalendarDays, UserRound, Undo2, Pencil, ThumbsDown, Trash2, Archive } from 'lucide-react'
import { useState } from 'react'
import type { ScoredItem, SessionSummary, InboxAlert } from '../../../../shared/protocol.js'
import { rowOpen } from '../../tabs.js'
import { briefPill } from '../../briefStore.js'
import { shortAge, LABELS, kindIcon, itemTone, priorityClass, PRIORITY_LABEL, PRIORITY_VALUES } from '../../itemUi.js'
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from '../../ui/Menu.js'
import { dueOf, dueChip, SECTION_ORDER, sectionTitle } from '../../../../core/work/due.js'
import { STAGE_LABEL, type ItemFlow, TURN_LABEL } from '../../../../core/work/flow.js'
import { type InboxTab, type TabEntry, isOpenTab, waitedFor } from '../../../../core/work/inbox-tabs.js'
import { waitingText } from '../../inboxTabs.js'
import { DUE_KEY_OF, signalsText } from './rowHelpers.js'
import type { RowActions } from './SelectionBar.js'

export const EMPTY_TEXT: Partial<Record<InboxTab, string>> = {
  needs: 'Nothing is held on you — no agent is waiting, nothing broke.',
  due: 'Nothing is due today.',
  people: 'Nobody is waiting on you.',
  new: 'Nothing new in the last day.',
  ready: 'No brief is waiting on you.',
  ai: 'The AI isn’t working on anything.',
  review: 'Nothing to review.',
  others: 'Nobody is holding anything of yours.',
  backlog: 'The backlog is empty.',
}

/**
 * An item row with the sessions dispatched for it that are held on a prompt,
 * one line each beneath it — answering one opens the session.
 */
export function WorkRowWithSessions({
  entry,
  sessions,
  selected,
  onOpenSession,
  ...actions
}: {
  entry: TabEntry<ScoredItem>
  sessions?: readonly SessionSummary[]
  selected: boolean
  onOpenSession: (id: string) => void
} & RowActions) {
  return (
    <>
      <WorkRow item={entry.item} entry={entry} selected={selected} {...actions} />
      {sessions?.map((s) => (
        <SessionRow key={s.id} session={s} nested onOpen={() => onOpenSession(s.id)} />
      ))}
    </>
  )
}

/** A session held on a permission prompt or a question. */
export function SessionRow({
  session,
  project,
  nested,
  onOpen,
}: {
  session: SessionSummary
  project?: string
  nested?: boolean
  onOpen: () => void
}) {
  const what = waitingText(session)
  return (
    <div className={`wrow sessionRow${nested ? ' nested' : ''}`}>
      <span className="check" aria-hidden="true" />
      <span className="bar" />
      <span className="glyph">
        {session.waitingOn === 'AskUserQuestion' ? <MessageCircleQuestion size={14} aria-hidden="true" /> : <ShieldQuestion size={14} aria-hidden="true" />}
      </span>
      <button type="button" className="t" title={`${session.title} — ${what}`} onClick={onOpen}>
        <span className="name">{nested ? what : session.title}</span>
        {!nested && <span className="why">{what}</span>}
      </button>
      <span className="meta">
        <span className="c state flow-ask">Answer</span>
        <span className="c src">{nested ? session.title : project ?? ''}</span>
        <span className="c when">{shortAge(session.updatedAt)}</span>
      </span>
    </div>
  )
}

/** Something broke that isn't an item — opens where it can be fixed. */
export function AlertRow({ alert, onOpen }: { alert: InboxAlert; onOpen: () => void }) {
  return (
    <div className="wrow alert alertRow">
      <span className="check" aria-hidden="true" />
      <span className="bar" />
      <span className="glyph">
        <AlertTriangle size={14} aria-hidden="true" />
      </span>
      <button type="button" className="t" title={alert.detail ?? alert.title} onClick={onOpen}>
        <span className="name">{alert.title}</span>
        {alert.detail && <span className="why">{alert.detail}</span>}
      </button>
      <span className="meta">
        <span className="c state flow-broken">{alert.kind === 'job' ? 'Open job' : 'Open run'}</span>
        <span className="c when">{alert.at ? shortAge(alert.at) : ''}</span>
      </span>
    </div>
  )
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The state cell: what is asked of you on your turn, else who has it. A
 * broken item says what broke; that outranks everything.
 */
function rowState(item: ScoredItem, brief: { label: string; tone: string } | null): { text: string; tone: string } {
  const f = item.flow
  if (!f) return { text: brief?.label ?? (LABELS[item.label] ?? LABELS.read).name, tone: brief ? brief.tone : `label-${item.label}` }
  if (f.broken) return { text: cap(f.broken), tone: 'flow-broken' }
  if (f.turn === 'me') return f.ask ? { text: cap(f.ask), tone: 'flow-ask' } : { text: (LABELS[item.label] ?? LABELS.read).name, tone: `label-${item.label}` }
  if (f.turn === 'ai') return { text: f.stage === 'briefing' ? (brief?.label === 'brief queued' ? 'Brief queued' : 'Briefing…') : 'AI working', tone: 'flow-ai' }
  if (f.turn === 'others') return { text: f.note ? f.note : 'Waiting', tone: 'flow-others' }
  return { text: STAGE_LABEL[f.stage], tone: 'flow-none' }
}

function flowTitle(f: ItemFlow): string {
  return `${STAGE_LABEL[f.stage]} · ${TURN_LABEL[f.turn]}${f.overridden ? ' — set by you' : ''}${f.note ? ` — ${f.note}` : ''}`
}

/**
 * One work item, one line (.docs/work-item-variations.html — variation A).
 *
 * The row is a ledger entry, not a card: state, source and age sit in
 * fixed-width right-aligned cells so they form columns down the page, and
 * scanning happens by alignment rather than by reading a strip of pills. The
 * right-hand cells are the row's one piece of real estate and three things
 * take turns in it, never two at once — the meta columns at rest, the
 * shortcut legend when the row is keyboard-selected, the action cluster on
 * hover. Because they swap in place, nothing reflows under the cursor.
 */
export function WorkRow({
  item,
  selected,
  tab,
  projectName,
  onSelect,
  onOpen,
  onPin,
  onDispatch,
  onGoal,
  onDone,
  onSnooze,
  onArchive,
  onReopen,
  onRefineJob,
  onSetPriority,
  onSetDue,
  onPickDue,
  onEdit,
  onDelete,
  checked,
  onToggle,
  onBrief,
  briefOf,
  onSetTurn,
  entry,
}: { item: ScoredItem; selected: boolean; entry?: TabEntry<ScoredItem> } & RowActions) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isManual = item.source === 'manual'
  const isOpen = isOpenTab(tab)
  const isChecked = checked.has(item.id)
  const brief = briefPill(briefOf(item.id))
  const pri = item.priority ?? 0
  // jobId now rides in the provenance list; fall back to the item field.
  const jobId = item.jobId ?? item.foundBy?.[item.foundBy.length - 1]?.jobId
  const Icon = kindIcon(item)
  const alert = itemTone(item) === 'red'

  // The state cell: the ask on your turn, else who has it (rowState).
  const state = rowState(item, brief)
  const flow = item.flow
  const signals = signalsText(item)
  // Tab extras: how long a person has waited, a stuck wait to nudge.
  const now = Date.now()
  const waited = tab === 'people' ? waitedFor(Date.parse(item.createdAt) || now, now) : null
  const stuck = entry?.stuck && flow ? waitedFor(flow.since, now) : null
  // Only a stated deadline gets a date chip; a late one you set says how late.
  const due = isOpen ? dueOf(item, Date.now()) : null
  // A date you picked shows too when its section can't say it (This week, Later).
  const showsDate = due?.source === 'explicit' || (due?.source === 'you' && (due.section === 'later' || due.section === 'this-week'))
  const dueText = !due ? null : due.late > 0 ? `${due.late}d late` : showsDate && due.at != null ? dueChip(due.at, Date.now()) : null
  const source = projectName(item.projectId) ?? item.repo
  // The scored reason ("2 people waiting · opened 3d ago") is the fallback when
  // the item carries no human note.
  const trailing = item.why || item.reason

  return (
    <div
      className={['wrow', priorityClass(item), selected && 'sel', isChecked && 'checked', menuOpen && 'menu', alert && 'alert']
        .filter(Boolean)
        .join(' ')}
      ref={selected ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
      onMouseMove={() => !selected && onSelect(item.id)}
    >
      {isOpen ? (
        <button
          type="button"
          className="check"
          title={isChecked ? 'Uncheck (Space)' : 'Check to act on several rows at once (Space)'}
          aria-pressed={isChecked}
          onClick={() => onToggle(item.id)}
        >
          {isChecked ? <CheckSquare size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />}
        </button>
      ) : (
        <span />
      )}
      <span className="bar" title={pri > 0 ? `Priority: ${PRIORITY_LABEL[pri]}` : undefined} />
      <span className="glyph">
        <Icon size={14} aria-hidden="true" />
      </span>
      <button
        type="button"
        className="t"
        title={item.title}
        {...rowOpen(
          () => onOpen(item.id),
          () => onPin(item.id, item.title),
        )}
      >
        {item.returned && (
          <span className="returned" title="Was done — the source updated since">
            ↩
          </span>
        )}
        <span className="name">{item.title}</span>
        {signals && <span className="signals">{signals}</span>}
        {dueText && (
          <span
            className={`due${due?.late ? ' late' : ''}${due?.source === 'explicit' ? ' explicit' : ''}`}
            title={due?.at != null ? `${due.source === 'explicit' ? 'Deadline' : 'Due'} ${new Date(due.at).toLocaleDateString()}` : undefined}
          >
            {dueText}
          </span>
        )}
        {entry?.badge && <span className={`fresh ${entry.badge}`}>{entry.badge === 'new' ? 'New' : 'Updated'}</span>}
        {waited && <span className="waited">waiting {waited}</span>}
        {stuck && <span className="waited stuck">stuck {stuck}</span>}
        {trailing && <span className="why">{trailing}</span>}
      </button>

      <span className="meta" aria-hidden={selected || undefined}>
        {flow && (
          <span className={`c stage turn-${flow.turn}${flow.overridden ? ' set' : ''}`} title={flowTitle(flow)}>
            <span className="dot" aria-hidden="true" />
            {STAGE_LABEL[flow.stage]}
          </span>
        )}
        <span className={`c state ${state.tone}`}>{state.text}</span>
        <span className="c src">{source}</span>
        <span className="c when" title={item.updatedAt ? new Date(item.updatedAt).toLocaleString() : undefined}>
          {shortAge(item.updatedAt)}
        </span>
      </span>

      {selected && (
        <span className="keys" aria-hidden="true">
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">d</span> dispatch
          </span>
          {isOpen && (
            <>
              <span>
                <span className="kbd">e</span> done
              </span>
              <span>
                <span className="kbd">z</span> snooze
              </span>
            </>
          )}
        </span>
      )}

      <span className="acts">
        {stuck ? (
          <button
            type="button"
            className="btn sm primary"
            title={`Waiting ${stuck} — nudge them${item.url ? ' at the source' : ''}`}
            onClick={() => (item.url ? window.open(item.url, '_blank', 'noopener') : onOpen(item.id))}
          >
            Nudge?
          </button>
        ) : isOpen ? (
          <button type="button" className="btn sm primary" title="Start a Claude Code session on this item (d)" onClick={() => onDispatch(item)}>
            Dispatch
          </button>
        ) : (
          <button type="button" className="btn sm primary" title="Move back to the open inbox (e)" onClick={() => onReopen(item)}>
            Reopen
          </button>
        )}
        {isOpen && (
          <>
            <button type="button" className="iconBtn sm" title={brief ? 'Re-brief (b)' : 'Create a brief (b)'} onClick={() => onBrief(item)}>
              <Sparkles size={13} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm green" title="Mark done (e)" onClick={() => onDone(item)}>
              <Check size={14} aria-hidden="true" />
            </button>
            <button type="button" className="iconBtn sm" title="Snooze until tomorrow 9am (z)" onClick={() => onSnooze(item)}>
              <AlarmClock size={13} aria-hidden="true" />
            </button>
          </>
        )}
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger asChild>
            <button type="button" className="iconBtn sm more" title="More actions">
              <MoreHorizontal size={15} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="rowMenu">
            <MenuItem onSelect={() => onOpen(item.id)}>
              <ChevronRight size={13} aria-hidden="true" /> Open item<span className="k">↵</span>
            </MenuItem>
            {item.url && (
              <MenuItem onSelect={() => window.open(item.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Open at the source<span className="k">o</span>
              </MenuItem>
            )}
            {item.linked?.map((l) => (
              <MenuItem key={l.id} onSelect={() => window.open(l.url, '_blank', 'noopener')}>
                <ExternalLink size={13} aria-hidden="true" /> Also in {l.source} · {l.repo}
              </MenuItem>
            ))}
            {isOpen ? (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onBrief(item)}>
                  <Sparkles size={13} aria-hidden="true" /> {brief ? 'Re-brief' : 'Create a brief'}
                  <span className="k">b</span>
                </MenuItem>
                <MenuItem onSelect={() => onDispatch(item)}>
                  <Play size={13} aria-hidden="true" /> Dispatch to a session<span className="k">d</span>
                </MenuItem>
                <MenuItem onSelect={() => onGoal(item)}>
                  <Target size={13} aria-hidden="true" /> Turn into a goal
                </MenuItem>
                <MenuItem onSelect={() => onDone(item)}>
                  <Check size={13} aria-hidden="true" /> Mark done<span className="k">e</span>
                </MenuItem>
                <MenuItem onSelect={() => onSnooze(item)}>
                  <AlarmClock size={13} aria-hidden="true" /> Snooze to tomorrow<span className="k">z</span>
                </MenuItem>
                <MenuSeparator />
                <div className="uiMenuCap">Due</div>
                {SECTION_ORDER.map((s) => (
                  <MenuItem key={s} onSelect={() => onSetDue(item, s)}>
                    <CalendarDays size={13} aria-hidden="true" /> {sectionTitle(s, Date.now())}
                    {due?.source !== 'default' && due?.section === s && <Check className="check" size={13} aria-hidden="true" />}
                    <span className="k">{DUE_KEY_OF[s]}</span>
                  </MenuItem>
                ))}
                <MenuItem onSelect={() => onPickDue(item)}>
                  <CalendarDays size={13} aria-hidden="true" /> Pick a date…
                  {due?.source === 'you' && due.at != null && <span className="k">{dueChip(due.at, Date.now())}</span>}
                </MenuItem>
                <MenuSeparator />
                <div className="uiMenuCap">Whose turn</div>
                {(['me', 'ai', 'others'] as const).map((t) => (
                  <MenuItem key={t} onSelect={() => onSetTurn(item, t)}>
                    <UserRound size={13} aria-hidden="true" /> {TURN_LABEL[t]}
                    {flow?.turn === t && <Check className="check" size={13} aria-hidden="true" />}
                  </MenuItem>
                ))}
                {flow?.overridden && (
                  <MenuItem onSelect={() => onSetTurn(item, null)}>
                    <Undo2 size={13} aria-hidden="true" /> Back to automatic
                  </MenuItem>
                )}
                <MenuSeparator />
                <div className="uiMenuCap">Priority</div>
                {PRIORITY_VALUES.map((v) => (
                  <MenuItem key={v} onSelect={() => onSetPriority(item, v)}>
                    <span className={`dot sm prio${v}`} aria-hidden="true" />
                    {v === 0 ? 'None' : PRIORITY_LABEL[v]}
                    {v === pri && <Check className="check" size={13} aria-hidden="true" />}
                  </MenuItem>
                ))}
                <MenuSeparator />
                {isManual && (
                  <MenuItem onSelect={() => onEdit(item)}>
                    <Pencil size={13} aria-hidden="true" /> Edit
                  </MenuItem>
                )}
                {jobId && (
                  <MenuItem onSelect={() => onRefineJob(item)}>
                    <ThumbsDown size={13} aria-hidden="true" /> Bad match — refine this job
                  </MenuItem>
                )}
                <MenuItem className="danger" onSelect={() => (isManual ? onDelete(item) : onArchive(item))}>
                  {isManual ? <Trash2 size={13} aria-hidden="true" /> : <Archive size={13} aria-hidden="true" />}
                  {isManual ? 'Delete' : 'Archive'}
                  <span className="k">x</span>
                </MenuItem>
              </>
            ) : (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => onReopen(item)}>
                  <Undo2 size={13} aria-hidden="true" /> Move back to open<span className="k">e</span>
                </MenuItem>
                {tab !== 'archived' && (
                  <MenuItem className="danger" onSelect={() => onArchive(item)}>
                    <Archive size={13} aria-hidden="true" /> Archive<span className="k">x</span>
                  </MenuItem>
                )}
              </>
            )}
          </MenuContent>
        </Menu>
      </span>
    </div>
  )
}
