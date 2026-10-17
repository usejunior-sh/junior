/**
 * Where a new session runs within its project (.docs/worktrees-ux.html §1):
 * the main folder, a worktree that already exists, or a new worktree on a
 * branch you name. Sits beside the project picker in the prompt head. A new
 * worktree's branch is edited inline, pre-filled from the prompt (or, for a
 * dispatched item, from the item's title).
 */
import { Check, ChevronDown, Folder, GitBranch, Plus } from 'lucide-react'
import type { Checkout } from '../../../shared/protocol.js'
import { plausibleBranch } from '../../../shared/branch.js'
import { checkoutLabel } from '../checkouts.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'

/** `/Users/you/Code/x` → `~/Code/x`: display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

type Props = {
  projectName: string
  /** the project's live checkouts, main first */
  checkouts: readonly Checkout[]
  /** the picked existing checkout; absent = main */
  checkoutId?: string
  /** set = "New worktree" is picked, on this branch */
  newBranch?: string
  onPick: (pick: { checkoutId?: string; newBranch?: string }) => void
  /** a branch name for "New worktree", from what's been typed so far */
  suggest: () => string
  /** sessions already in a checkout, so a row says whether it's busy */
  sessionsIn: (checkoutId: string) => number
}

export function CheckoutPicker({ projectName, checkouts, checkoutId, newBranch, onPick, suggest, sessionsIn }: Props) {
  const isNew = newBranch !== undefined
  const main = checkouts.find((c) => c.kind === 'main')
  const picked = isNew ? undefined : (checkouts.find((c) => c.id === checkoutId) ?? main)
  const worktrees = checkouts.filter((c) => c.kind === 'worktree')
  const bad = isNew && newBranch.trim() !== '' && !plausibleBranch(newBranch.trim())
  const here = (id: string) => {
    const n = sessionsIn(id)
    return n ? `${n} session${n === 1 ? '' : 's'} here` : 'no sessions yet'
  }

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={`chip ink pick coPick${isNew || picked?.kind === 'worktree' ? ' wt' : ''}`}
            title={isNew ? 'A new worktree, made when you send' : picked ? `Runs in ${picked.path}` : 'Checkout'}
          >
            {isNew || picked?.kind === 'worktree' ? (
              <GitBranch size={12} className="g" aria-hidden="true" />
            ) : (
              <Folder size={12} className="g" aria-hidden="true" />
            )}
            <span className="name">{isNew ? 'new worktree' : picked ? checkoutLabel(picked) : 'main'}</span>
            <ChevronDown size={11} aria-hidden="true" />
          </button>
        </MenuTrigger>
        <MenuContent className="wide">
          <div className="coMenuCap">
            <span className="b">Checkout · {projectName}</span>
          </div>
          {main && (
            <MenuItem onSelect={() => onPick({})}>
              <Folder size={14} aria-hidden="true" />
              <span className="text">
                <span className="name">Main folder · {checkoutLabel(main)}</span>
                <span className="desc">
                  {homely(main.path)} · {here(main.id)}
                </span>
              </span>
              {!isNew && picked?.id === main.id && <Check className="check" size={13} aria-hidden="true" />}
            </MenuItem>
          )}
          {worktrees.map((c) => (
            <MenuItem key={c.id} onSelect={() => onPick({ checkoutId: c.id })}>
              <GitBranch size={14} className="wtIcon" aria-hidden="true" />
              <span className="text">
                <span className="name mono">{checkoutLabel(c)}</span>
                <span className="desc">{here(c.id)}</span>
              </span>
              {!isNew && picked?.id === c.id && <Check className="check" size={13} aria-hidden="true" />}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onSelect={() => onPick({ newBranch: isNew ? newBranch : suggest() })}>
            <Plus size={14} aria-hidden="true" />
            <span className="text">
              <span className="name">New worktree</span>
              <span className="desc">a new branch from the default one · node_modules and .env copied in</span>
            </span>
            {isNew && <Check className="check" size={13} aria-hidden="true" />}
          </MenuItem>
        </MenuContent>
      </Menu>
      {isNew && (
        <input
          className={`brInput${bad ? ' bad' : ''}`}
          value={newBranch}
          placeholder="fix/what-it-is"
          spellCheck={false}
          aria-label="Branch for the new worktree"
          title={bad ? "Git won't take that as a branch name" : 'Branch for the new worktree'}
          size={Math.max(14, Math.min(40, newBranch.length + 1))}
          onChange={(e) => onPick({ newBranch: e.target.value })}
        />
      )}
    </>
  )
}
