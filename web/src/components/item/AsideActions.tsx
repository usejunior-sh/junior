import { Play, Sparkles, Check, AlarmClock, Archive, ChevronDown, CalendarDays, Folder } from 'lucide-react'
import type { ScoredItem, Project, ItemStatus, BriefView } from '../../../../shared/protocol.js'
import { projectColor } from '../../tabs.js'
import { PRIORITY_LABEL, PRIORITY_VALUES } from '../../itemUi.js'
import { Menu, MenuTrigger, MenuContent, MenuItem, MenuSeparator } from '../../ui/Menu.js'
import { dueOf, type Section, SECTION_ORDER, sectionTitle } from '../../../../core/work/due.js'
import { choosesProject, ProjectIdPicker, defaultProjectOf } from '../ProjectPicker.js'
import type { LinkedSession } from './types.js'

export function AsideActions({
  item,
  linkedSessions,
  projects,
  status,
  isOpen,
  settled,
  brief,
  pri,
  due,
  dueLabel,
  onDispatch,
  setBriefOpen,
  setPickingDue,
  setState,
  snooze1d,
  setPriority,
  setDue,
  setProject,
}: {
  item: ScoredItem
  linkedSessions: LinkedSession[]
  projects: Project[]
  status: ItemStatus
  isOpen: boolean
  settled: boolean
  brief: BriefView | null
  pri: number
  due: ReturnType<typeof dueOf>
  dueLabel: string
  onDispatch: (item: ScoredItem) => void
  setBriefOpen: (open: boolean) => void
  setPickingDue: (open: boolean) => void
  setState: (status: ItemStatus, snoozeUntil?: number) => Promise<void>
  snooze1d: () => void
  setPriority: (priority: number) => void
  setDue: (due: Section | string) => void
  setProject: (projectId: string) => void
}) {
  return (
    <>
      <div className="asideActions">
        <button type="button" className="btn primary wide" onClick={() => onDispatch(item)} title="Start a chat on this item — the brief rides along if there is one">
          <Play size={12} aria-hidden="true" />
          {linkedSessions.some((x) => x.role === 'dispatch') ? 'Start another chat' : 'Start a chat'}
        </button>
        {isOpen && settled && (
          <button type="button" className="btn wide" onClick={() => setBriefOpen(true)}>
            <Sparkles size={12} aria-hidden="true" /> {brief?.artifact ? 'Re-brief' : 'Create brief'}
          </button>
        )}
        {isOpen ? (
          <div className="segRow">
            <button type="button" title="Mark done (e)" onClick={() => void setState('done')}>
              <Check size={12} aria-hidden="true" /> Done
            </button>
            <button type="button" title="Snooze until tomorrow 9am (z)" onClick={snooze1d}>
              <AlarmClock size={12} aria-hidden="true" /> Snooze
            </button>
            <button type="button" title="Archive (x)" onClick={() => void setState('archived')}>
              <Archive size={12} aria-hidden="true" /> Archive
            </button>
          </div>
        ) : (
          <div className="segRow">
            <button type="button" onClick={() => void setState('open')}>
              Reopen
            </button>
            {status !== 'archived' && (
              <button type="button" onClick={() => void setState('archived')}>
                <Archive size={12} aria-hidden="true" /> Archive
              </button>
            )}
          </div>
        )}
        {isOpen && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className={`prioBar prio${pri}`} title="Set priority">
                <span className="dot" aria-hidden="true" />
                <span className="lab">Priority</span>
                <span className="val">{pri === 0 ? 'None' : PRIORITY_LABEL[pri]}</span>
                <ChevronDown className="caret" size={13} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <div className="uiMenuCap">Priority</div>
              {PRIORITY_VALUES.map((v) => (
                <MenuItem key={v} onSelect={() => setPriority(v)}>
                  <span className={`dot sm prio${v}`} aria-hidden="true" />
                  {v === 0 ? 'None' : PRIORITY_LABEL[v]}
                  {v === pri && <Check className="check" size={13} aria-hidden="true" />}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {isOpen && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className={`prioBar${due.late > 0 ? ' late' : ''}`} title="Set due date">
                <CalendarDays size={12} className="caret" aria-hidden="true" />
                <span className="lab">Due</span>
                <span className="val">{due.late > 0 ? `${due.late}d late` : dueLabel}</span>
                <ChevronDown className="caret" size={13} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="end">
              <div className="uiMenuCap">Due</div>
              {SECTION_ORDER.map((s) => (
                <MenuItem key={s} onSelect={() => setDue(s)}>
                  {sectionTitle(s, Date.now())}
                  {due.source !== 'default' && due.section === s && (
                    <Check className="check" size={13} aria-hidden="true" />
                  )}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onSelect={() => setPickingDue(true)}>
                <CalendarDays size={13} aria-hidden="true" /> Pick a date…
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        {isOpen && item.source === 'manual' && choosesProject(projects) && (
          <ProjectIdPicker
            projects={projects}
            value={item.projectId ?? defaultProjectOf(projects)?.id ?? ''}
            allowNone={false}
            onChange={(id) => id && setProject(id)}
          >
            {(current) => (
              <button type="button" className="prioBar" title="Set project">
                {current ? (
                  <span className="dot" style={{ background: projectColor(current.id) }} aria-hidden="true" />
                ) : (
                  <Folder size={12} className="caret" aria-hidden="true" />
                )}
                <span className="lab">Project</span>
                <span className="val">{current?.name ?? 'None'}</span>
                <ChevronDown className="caret" size={13} aria-hidden="true" />
              </button>
            )}
          </ProjectIdPicker>
        )}
      </div>
    </>
  )
}
