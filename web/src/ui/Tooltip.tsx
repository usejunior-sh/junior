/**
 * A thin, styled wrapper around Radix's tooltip, Junior's speech bubble when
 * you hover its face in a chat. Radix owns the timing (a short delay so a
 * passing pointer doesn't flicker it), the positioning and the accessibility;
 * we own the pixels via the `uiTip*` classes in styles/*.css. Content is
 * portaled like the menus are (see portalContainer.ts), so it lands inside a
 * modal dialog when the trigger sits in one.
 */
import * as T from '@radix-ui/react-tooltip'
import { useState, type CSSProperties, type ReactNode } from 'react'
import { usePortalContainer } from './portalContainer.js'

export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'start',
  delay = 160,
  className,
  style,
}: {
  content: ReactNode
  /** the trigger: one element that can take a ref */
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delay?: number
  className?: string
  /** custom properties for the bubble (Junior's colour) */
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const { anchorRef, container } = usePortalContainer(open)
  return (
    <T.Provider delayDuration={delay} skipDelayDuration={300}>
      <T.Root open={open} onOpenChange={setOpen}>
        <T.Trigger asChild ref={anchorRef}>
          {children}
        </T.Trigger>
        <T.Portal container={container}>
          <T.Content className={`uiTip${className ? ` ${className}` : ''}`} style={style} side={side} align={align} sideOffset={6} collisionPadding={8}>
            {content}
            <T.Arrow className="uiTipArrow" width={10} height={5} />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  )
}
