/**
 * The checkout chip (.docs/worktrees-ux.html §0): where something runs. The
 * main checkout stays quiet — `project · branch`, like the old folder pill;
 * only a worktree gets the branch glyph and the blue edge. A removed one
 * strikes through. At most one trailing fact (ahead count, a state word), so
 * it fits a narrow panel.
 */
import { ChevronDown, GitBranch } from 'lucide-react'
import type { ComponentProps } from 'react'
import type { Checkout } from '../../../shared/protocol.js'
import { checkoutLabel } from '../checkouts.js'

type Props = Omit<ComponentProps<'button'>, 'children'> & {
  checkout: Checkout
  /** the project's name, shown on a main checkout */
  projectName?: string
  /** the project's hue (`projectColor`) */
  color: string
  trailing?: string
  /** a chevron: the chip opens a menu */
  menu?: boolean
  size?: 'sm'
}

export function CheckoutChip({ checkout, projectName, color, trailing, menu, size, className, ...button }: Props) {
  const wt = checkout.kind === 'worktree'
  const gone = checkout.state === 'removed'
  const cls = ['co', wt && 'wt', gone && 'gone', size, className].filter(Boolean).join(' ')
  return (
    <button type="button" className={cls} title={checkout.path} {...button}>
      <span className="pdot" style={{ background: color }} aria-hidden="true" />
      {wt ? (
        <GitBranch size={size ? 10 : 11} className="g" aria-hidden="true" />
      ) : (
        projectName && (
          <>
            <span className="pn">{projectName}</span>
            {checkout.branch && <span className="sep">·</span>}
          </>
        )
      )}
      {(wt || checkout.branch) && <span className="b">{checkoutLabel(checkout)}</span>}
      {gone ? <span className="x">removed</span> : trailing && <span className="x">{trailing}</span>}
      {menu && <ChevronDown size={9} className="chev" aria-hidden="true" />}
    </button>
  )
}
