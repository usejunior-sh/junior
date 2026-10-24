/** Shared guards for global hotkeys. */
import { shortcutsFor } from './shortcuts.js'

export { isFrictionKey } from './shortcuts.js'

/** True when the event originates in a text-entry control, letter keys belong to it. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * True while any <dialog> or popover menu is open, single-key hotkeys should
 * stay quiet, or "n" typed at an open menu starts a new session behind it.
 */
export function anyDialogOpen(): boolean {
  return (
    document.querySelector(
      'dialog[open], [data-popover-open], [data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
    ) !== null
  )
}

/**
 * True while a modal is up that isn't the palette or the `?` overlay (those
 * two close for a global key): a native modal `<dialog>`, or a Radix Dialog /
 * AlertDialog (the palette is `#palette`, the overlay `#helpOverlay`, both Radix). Popovers and menus don't count; they sit in a popper wrapper.
 */
export function blockingModalOpen(): boolean {
  const native = [...document.querySelectorAll('dialog')].some((d) => d.matches(':modal'))
  if (native) return true
  return [...document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')].some(
    (el) => el.id !== 'palette' && el.id !== 'helpOverlay' && !el.closest('[data-radix-popper-content-wrapper]'),
  )
}

/**
 * True for the second key of a `g` sequence (`g t`, `g j`): App handles it as
 * navigation, so a page's own single-key hotkeys must stand aside. Recorded in
 * the capture phase, before any page listener sees the event; the window
 * matches App's prefix timer.
 */
export function isGoSequence(e: KeyboardEvent): boolean {
  return goSeq.has(e)
}
const goSeq = new WeakSet<KeyboardEvent>()
let gAt = -Infinity
document.addEventListener(
  'keydown',
  (e) => {
    if (isTypingTarget(e) || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'g') {
      gAt = e.timeStamp
      return
    }
    if (e.timeStamp - gAt < 1000) goSeq.add(e)
    gAt = -Infinity
  },
  true,
)

export const isMac = navigator.platform.startsWith('Mac')
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl+'

/** Every global key, for the `?` overlay and the Shortcuts settings tab (shortcuts.ts, pure, so tests can read it). */
export const SHORTCUTS = shortcutsFor(MOD_LABEL)
