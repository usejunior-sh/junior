import * as Popover from '@radix-ui/react-popover'
import { forwardRef, useEffect, useRef, type ReactNode } from 'react'
import type { CommandHit } from '../commands.js'

type Props = {
  open: boolean
  hits: readonly CommandHit[]
  /** the list is still being fetched: say so rather than claim there is nothing */
  loading: boolean
  /** index into `hits` */
  selected: number
  onHover: (index: number) => void
  onPick: (c: CommandHit) => void
  /** the textarea the popover hangs off */
  children: ReactNode
}

/**
 * The `/` picker: a popover above the prompt box listing the commands and
 * skills this folder's Claude Code actually has. Its own, the user's, the
 * project's, and every plugin's.
 *
 * The `@` picker's sibling and deliberately the plainer one: there are no tabs
 * because there is only one kind of thing here, and no attachment to track
 * because picking a command just writes text. Focus never leaves the textarea,
 * so the keystrokes that move the selection are the same ones still narrowing
 * the list.
 *
 * It forwards its ref onto its own anchor so the `@` picker, which wraps this
 * component in *its* `Popover.Anchor asChild`, still reaches the real box: both
 * popovers end up anchored to the one `boxWrap` DOM node. Without the forward
 * the outer anchor's ref would land on a function component and be dropped, and
 * the `@` picker would never position or open.
 */
export const SlashPicker = forwardRef<HTMLDivElement, Props>(function SlashPicker(
  { open, hits, loading, selected, onHover, onPick, children },
  anchorRef,
) {
  const list = useRef<HTMLDivElement>(null)

  // Keep the selected row in view as the arrow keys move it.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('.mnOpt.sel')
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <Popover.Root open={open}>
      <Popover.Anchor asChild ref={anchorRef}>
        {children}
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="mnPop slPop"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="mnList" ref={list} role="listbox" aria-label="Command">
            {hits.length === 0 && (
              <div className="mnEmpty">
                {loading ? 'Reading this folder’s commands…' : 'No command matches — keep typing, or write a message instead.'}
              </div>
            )}
            {hits.map((c, i) => (
              <button
                type="button"
                key={c.name}
                className={'mnOpt slOpt' + (i === selected ? ' sel' : '')}
                role="option"
                aria-selected={i === selected}
                // Move, not enter: a pointer resting where the list appears
                // must not steal the selection from the keys.
                onMouseMove={() => onHover(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onPick(c)}
                title={c.description}
              >
                <span className="n">/{c.name}</span>
                {c.argumentHint && <span className="args">{c.argumentHint}</span>}
                {c.via && <span className="via">/{c.via}</span>}
                {c.source && <span className="plug">{c.source}</span>}
                <span className="desc">{c.short}</span>
              </button>
            ))}
            {/* Junior's own verbs show at once; the folder's list may still be on its way. */}
            {hits.length > 0 && loading && <div className="mnEmpty">Reading this folder’s commands…</div>}
          </div>
          <div className="mnFoot">
            <span>
              <kbd>↑↓</kbd> move · <kbd>↵</kbd> insert · <kbd>esc</kbd> close
            </span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
})
