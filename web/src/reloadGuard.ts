/**
 * What on screen an automatic reload would cost you
 * (.docs/overnight-2026-10-24/designs/reload-on-build-change.md §3, "Busy").
 *
 * One mechanism: a component holding something in flight marks its root with
 * `data-reload-guard="<kind>"` while it is true (PromptBox with text or an
 * attachment, a card waiting on you, an editor with unsaved text). Two more
 * are read off the page itself: a text field you're typing in, and an open
 * Radix dialog.
 *
 * Only what is on screen counts. Composer drafts already persist in
 * localStorage, so a reload never loses them; what it loses is your place,
 * your caret and your train of thought, and those only exist on screen.
 */

export type ReloadBlocker = 'draft' | 'card' | 'edit' | 'typing' | 'dialog'

const KINDS: ReadonlySet<string> = new Set<ReloadBlocker>(['draft', 'card', 'edit', 'typing', 'dialog'])

/** A focused field with something in it. An empty one, autofocused composer included, loses nothing. */
export function isTypingIn(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return el.value.trim() !== ''
  if (el instanceof HTMLInputElement) {
    const textual = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''].includes(el.type)
    return textual && el.value.trim() !== ''
  }
  return el instanceof HTMLElement && el.isContentEditable && (el.textContent ?? '').trim() !== ''
}

/**
 * The blockers on the page now. `hidden`: the window is in the background,
 * where nobody is typing, so a focused field doesn't count.
 */
export function reloadBlockers(opts: { hidden?: boolean } = {}): Set<ReloadBlocker> {
  const out = new Set<ReloadBlocker>()
  for (const el of document.querySelectorAll('[data-reload-guard]')) {
    const kind = el.getAttribute('data-reload-guard') ?? ''
    if (KINDS.has(kind)) out.add(kind as ReloadBlocker)
  }
  if (!opts.hidden && isTypingIn(document.activeElement)) out.add('typing')
  if (document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"]')) out.add('dialog')
  return out
}
