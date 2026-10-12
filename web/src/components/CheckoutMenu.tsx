/**
 * Everything you do with a checkout, from wherever it's shown (the session
 * header's chip, a Changes group): open it in an editor found on this Mac,
 * reveal it, open a terminal there, copy its path — and, for a worktree,
 * remove it once the work is done (.docs/worktrees-ux.html §4, §10).
 */
import { CodeXml, Copy, FolderOpen, SquareTerminal, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { Checkout } from '../../../shared/protocol.js'
import { checkoutLabel, openCheckout, useEditors } from '../checkouts.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/Menu.js'
import { RemoveWorktreeDialog } from './RemoveWorktreeDialog.js'

/** The end of a path is the part that tells folders apart: `…/triage-dev/feat-x`. */
function shortPath(p: string): string {
  const home = p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
  const parts = home.split('/')
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : home
}

type Props = {
  checkout: Checkout
  /** the trigger — rendered as-is (`asChild`), so it must be a button */
  children: ReactNode
  /** omit to leave "New terminal here" out */
  onNewTerminal?: () => void
  align?: 'start' | 'end'
}

export function CheckoutMenu({ checkout, children, onNewTerminal, align = 'start' }: Props) {
  const editors = useEditors()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const gone = checkout.state === 'removed'

  // The menu stays open while the editor launches, so a failure is said where it was asked for.
  function launch(editor: string) {
    return (e: Event) => {
      e.preventDefault()
      setError(null)
      void openCheckout(checkout.id, editor).then((err) => {
        if (err) setError(err)
        else setOpen(false)
      })
    }
  }

  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setError(null)
        }}
      >
        <MenuTrigger asChild>{children}</MenuTrigger>
        <MenuContent align={align} className="wide coMenu">
          <div className="coMenuCap" title={checkout.path}>
            <span className="b">{checkoutLabel(checkout)}</span>
            <span className="k">{gone ? 'removed' : checkout.kind === 'worktree' ? 'worktree' : 'main folder'}</span>
          </div>
          {error && <p className="uiMenuBlurb coMenuErr">{error}</p>}
          {editors.map((ed) => (
            <MenuItem key={ed.id} disabled={gone} onSelect={launch(ed.id)}>
              <CodeXml size={14} aria-hidden="true" />
              <span className="name">Open in {ed.name}</span>
            </MenuItem>
          ))}
          <MenuItem disabled={gone} onSelect={launch('finder')}>
            <FolderOpen size={14} aria-hidden="true" />
            <span className="name">Reveal in Finder</span>
          </MenuItem>
          {onNewTerminal && (
            <MenuItem disabled={gone} onSelect={onNewTerminal}>
              <SquareTerminal size={14} aria-hidden="true" />
              <span className="name">New terminal here</span>
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem onSelect={() => void navigator.clipboard?.writeText(checkout.path).catch(() => {})}>
            <Copy size={14} aria-hidden="true" />
            <span className="text">
              <span className="name">Copy path</span>
              <span className="desc" title={checkout.path}>
              {shortPath(checkout.path)}
            </span>
            </span>
          </MenuItem>
          {checkout.kind === 'worktree' && !gone && (
            <MenuItem className="danger" onSelect={() => setRemoving(true)}>
              <Trash2 size={14} aria-hidden="true" />
              <span className="name">Remove worktree…</span>
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <RemoveWorktreeDialog checkout={removing ? checkout : null} onClose={() => setRemoving(false)} />
    </>
  )
}
