/**
 * Focus return for a controlled Radix Dialog that has no `Dialog.Trigger`.
 *
 * Radix's modal content sends focus back to its trigger on close, and only
 * there: `onCloseAutoFocus` prevents the default and focuses `triggerRef`.
 * Our app-level dialogs are opened from state (a top-bar button, a menu item,
 * a hotkey), so there is no trigger and focus would fall to <body>. A native
 * `showModal()` dialog returned it to whatever had it before; this keeps that.
 *
 * The opener is read during render on the false → true edge, not in an
 * effect: an `autoFocus` field inside the content takes focus during the same
 * commit, before any parent effect runs, and Radix skips `onOpenAutoFocus`
 * when focus is already inside. If the opener is gone or was <body>
 * (onboarding opens by itself), Radix's default stands and nothing is focused.
 *
 * Opened from a menu item ("Delete…"), the opener is the item, which is gone
 * by the time the dialog closes. Then the menu's trigger (the "More" button)
 * stands in: Radix links them by the trigger's `aria-controls`, which is still
 * in the DOM during this render.
 */
import { useCallback, useRef } from 'react'

export function useReturnFocus(open: boolean): (event: Event) => void {
  const wasOpen = useRef(false)
  const opener = useRef<HTMLElement | null>(null)
  if (open && !wasOpen.current && typeof document !== 'undefined') {
    const el = document.activeElement
    opener.current = el instanceof HTMLElement && el !== document.body ? (menuTriggerOf(el) ?? el) : null
  }
  wasOpen.current = open

  return useCallback((event: Event) => {
    const el = opener.current
    opener.current = null
    if (!el || !el.isConnected) return
    event.preventDefault()
    el.focus({ preventScroll: true })
  }, [])
}

/** The button that opened the Radix menu `el` sits in, if it sits in one. */
function menuTriggerOf(el: HTMLElement): HTMLElement | null {
  const menu = el.closest('[role="menu"][id]')
  if (!menu) return null
  const trigger = document.querySelector(`[aria-controls="${CSS.escape(menu.id)}"]`)
  return trigger instanceof HTMLElement ? trigger : null
}
