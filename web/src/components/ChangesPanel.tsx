/**
 * The Changes panel: every project's uncommitted files, grouped project →
 * checkout. A project in one folder reads as a single flat group; one with
 * worktrees gets a sub-group per checkout (main first), each against its own
 * HEAD with its ahead count. A row opens the file in the content area. Its
 * diff and an editor. What it lists is the disk, not a session: anything that
 * changed a file (an agent, a terminal, your editor) shows up here.
 */
import { ChevronDown, ChevronRight, Folder, GitBranch, MoreHorizontal, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ChangeStatus, CheckoutChanges, ProjectChanges } from '../../../shared/protocol.js'
import { changesStore } from '../changesStore.js'
import { checkoutLabel } from '../checkouts.js'
import { projectColor, rowOpen } from '../tabs.js'
import { CheckoutMenu } from './CheckoutMenu.js'
import { PanelSearch } from './ContextPanel.js'

/** A poll, not a push: nothing tells the daemon a file changed on disk. */
const POLL_MS = 15_000
const collapsedKey = 'junior.changes.collapsed'

export const STATUS_LETTER: Record<ChangeStatus, string> = { modified: 'M', added: 'A', deleted: 'D' }

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

function readCollapsed(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

type Props = {
  projects: readonly ProjectChanges[]
  loaded: boolean
  loading: boolean
  current: { checkoutId: string; path: string } | null
  onOpen: (checkoutId: string, path: string) => void
  /** Keep it in the band without leaving where you are (⌘-click, middle-click). */
  onPin: (checkoutId: string, path: string) => void
  onNewTerminal: (checkoutId: string) => void
  onSearch: () => void
}

const fileCount = (pc: ProjectChanges) => pc.checkouts.reduce((n, c) => n + c.files.length, 0)

export function ChangesPanel({ projects, loaded, loading, current, onOpen, onPin, onNewTerminal, onSearch }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed)

  // Fresh on arrival, then a slow poll while the panel is on screen.
  useEffect(() => {
    void changesStore.refresh()
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void changesStore.refresh()
    }, POLL_MS)
    return () => window.clearInterval(t)
  }, [])

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(collapsedKey, JSON.stringify([...next]))
      } catch {
        // storage blocked: the toggle still works for this page load
      }
      return next
    })
  }

  // Dirty projects first; a clean one is still listed, so "no changes" is an answer.
  const ordered = [...projects].sort((a, b) => Number(fileCount(b) > 0) - Number(fileCount(a) > 0))
  const total = projects.reduce((n, p) => n + fileCount(p), 0)

  const files = (cc: CheckoutChanges, nested: boolean) =>
    cc.files.map((f) => {
      const sel = current?.checkoutId === cc.checkout.id && current.path === f.path
      const dir = dirName(f.path)
      return (
        <button
          key={f.path}
          type="button"
          className={`prow chg${nested ? ' nested' : ''}${sel ? ' sel' : ''}`}
          title={f.path}
          {...rowOpen(
            () => onOpen(cc.checkout.id, f.path),
            () => onPin(cc.checkout.id, f.path),
          )}
        >
          <span className={`st ${f.status}`}>{STATUS_LETTER[f.status]}</span>
          <span className="t">
            <span className="nm">{baseName(f.path)}</span>
            {dir && <span className="sub">{dir}</span>}
          </span>
          <span className="m">
            {f.isBinary ? (
              'bin'
            ) : (
              <>
                <span className="pl">+{f.insertions}</span> <span className="mn">−{f.deletions}</span>
              </>
            )}
          </span>
        </button>
      )
    })

  // "Open in…" and friends ride beside a group's toggle, never inside it. A button can't hold a button.
  const menu = (cc: CheckoutChanges) => (
    <CheckoutMenu checkout={cc.checkout} onNewTerminal={() => onNewTerminal(cc.checkout.id)} align="end">
      <button type="button" className="iconBtn sm coBtn" aria-label={`Open ${cc.checkout.path} in…`} title="Open in…">
        <MoreHorizontal size={13} aria-hidden="true" />
      </button>
    </CheckoutMenu>
  )

  const counts = (n: number, ins: number, del: number) =>
    n > 0 && (
      <span className="num">
        <span className="pl">+{ins}</span> <span className="mn">−{del}</span>
      </span>
    )

  return (
    <aside className="panel" aria-label="Changes">
      <PanelSearch onSearch={onSearch} placeholder="Search sessions, items…" />
      <div className="panelBody">
        <div className="panelHead">
          <span>Changes</span>
          <span className="n">{total}</span>
          <span className="acts">
            <button
              type="button"
              className={`iconBtn sm${loading ? ' spinning' : ''}`}
              title="Refresh"
              onClick={() => void changesStore.refresh()}
            >
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </span>
        </div>
        {loaded && projects.length === 0 && (
          <div className="panelEmpty">No projects yet. Add one in Settings → Projects and its uncommitted files show up here.</div>
        )}
        {ordered.map((pc) => {
          const open = !collapsed.has(pc.project.id)
          const n = fileCount(pc)
          const ins = pc.checkouts.reduce((m, c) => m + c.insertions, 0)
          const del = pc.checkouts.reduce((m, c) => m + c.deletions, 0)
          // One folder: today's flat group. Worktrees too: a sub-group per checkout.
          const only = pc.checkouts.length === 1 ? pc.checkouts[0] : null
          const error = only?.error
          const note = error
            ? 'git failed'
            : !pc.isRepo
              ? 'not a repo'
              : n === 0
                ? only || pc.checkouts.length === 0
                  ? 'clean'
                  : `${pc.checkouts.length} checkouts · clean`
                : !only
                  ? `${pc.checkouts.length} checkouts`
                  : null
          return (
            <div key={pc.project.id} className="chgGroup">
              <div className="chgHead">
                <button
                  type="button"
                  className="panelGroup asBtn"
                  aria-expanded={open}
                  title={`${pc.project.path}${only?.checkout.branch ? ` · ${only.checkout.branch}` : ''}${error ? `\n${error}` : ''}`}
                  onClick={() => toggle(pc.project.id)}
                >
                  {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
                  <span className="pdot" style={{ background: projectColor(pc.project.id) }} aria-hidden="true" />
                  <span className="nm">{pc.project.name}</span>
                  {n > 0 && <span className="n">{n}</span>}
                  {note && <span className="note">{note}</span>}
                  {counts(n, ins, del)}
                </button>
                {only && pc.isRepo && menu(only)}
              </div>
              {open && only && files(only, false)}
              {open &&
                !only &&
                pc.checkouts.map((cc) => {
                  const coOpen = !collapsed.has(`co:${cc.checkout.id}`)
                  const wt = cc.checkout.kind === 'worktree'
                  const fact = cc.error
                    ? 'git failed'
                    : [cc.ahead ? `↑${cc.ahead}` : null, cc.files.length === 0 ? 'clean' : null].filter(Boolean).join(' · ')
                  return (
                    <div key={cc.checkout.id}>
                      <div className="chgHead">
                        <button
                          type="button"
                          className={`panelGroup asBtn coGroup${wt ? ' wt' : ''}`}
                          aria-expanded={coOpen}
                          title={`${cc.checkout.path}${cc.error ? `\n${cc.error}` : ''}`}
                          disabled={cc.files.length === 0}
                          onClick={() => toggle(`co:${cc.checkout.id}`)}
                        >
                          {cc.files.length > 0 && coOpen ? (
                            <ChevronDown size={11} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={11} aria-hidden="true" />
                          )}
                          {wt ? <GitBranch size={11} className="g" aria-hidden="true" /> : <Folder size={11} className="g" aria-hidden="true" />}
                          <span className="br">{checkoutLabel(cc.checkout)}</span>
                          {cc.files.length > 0 && <span className="n">{cc.files.length}</span>}
                          {fact && <span className="note">{fact}</span>}
                          {counts(cc.files.length, cc.insertions, cc.deletions)}
                        </button>
                        {menu(cc)}
                      </div>
                      {coOpen && files(cc, true)}
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>
      <div className="panelFoot">
        vs HEAD · <span className="kbd">dbl-click</span> keeps the tab
      </div>
    </aside>
  )
}
