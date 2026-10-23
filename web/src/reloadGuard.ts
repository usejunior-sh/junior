/**
 * What on screen an automatic reload would cost you
 * (.docs/overnight-2026-10-24/designs/reload-on-build-change.md §3, "Busy").
 *
 * A component holding something in flight marks its root with
 * `data-reload-guard="<kind>"` while it is true (PromptBox with text or an
 * attachment, a card waiting on you, an editor with unsaved text). The rest is
 * read off the page itself: a text field you're typing in, an open dialog, and
 * a safety net for every editor that never marked itself: any editable field
 * on screen with text in it counts as an unsaved edit, focused or not, window
 * visible or not. Most of those editors keep nothing in storage, so a reload
 * would drop the text for good.
 *
 * Composer drafts (PromptBox, `#composer`) already persist in localStorage and
 * mark themselves, so the safety net skips them; xterm's helper textarea holds
 * no text of yours and is skipped too.
 *
 * The rules are pure (`blockersOf` over plain facts) so
 * test/reload-on-build.test.ts can walk them without a DOM; `reloadBlockers`
 * only gathers the facts.
 */

export type ReloadBlocker = 'draft' | 'card' | 'edit' | 'typing' | 'dialog'

const KINDS: ReadonlySet<string> = new Set<ReloadBlocker>(['draft', 'card', 'edit', 'typing', 'dialog'])

/** Input types that hold text you typed. */
const TEXTUAL: ReadonlySet<string> = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

/** One field on the page, as plain facts. */
export type FieldFacts = {
  kind: 'textarea' | 'input' | 'editable'
  /** an input's `type` */
  type?: string
  text: string
  readOnly?: boolean
  disabled?: boolean
  /** inside a composer that persists its own draft, or xterm's helper textarea */
  exempt?: boolean
}

export type PageFacts = {
  /** every `data-reload-guard` value on the page */
  guards: readonly string[]
  /** the focused field, if the focus is in one */
  focused: FieldFacts | null
  /** every editable field on screen */
  fields: readonly FieldFacts[]
  dialogOpen: boolean
  /** the window is in the background, where nobody is typing */
  hidden: boolean
}

/** A field with something typed in it. An empty one, autofocused composer included, loses nothing. */
export function holdsText(f: FieldFacts): boolean {
  if (f.kind === 'input' && !TEXTUAL.has(f.type ?? '')) return false
  return f.text.trim() !== ''
}

/**
 * A field whose text a reload would drop: editable, not a persisted composer,
 * and not a search box (a filter isn't an edit, and the confirm would say so).
 */
export function holdsUnsavedText(f: FieldFacts): boolean {
  if (f.exempt || f.readOnly || f.disabled) return false
  if (f.kind === 'input' && f.type === 'search') return false
  return holdsText(f)
}

export function blockersOf(p: PageFacts): Set<ReloadBlocker> {
  const out = new Set<ReloadBlocker>()
  for (const kind of p.guards) if (KINDS.has(kind)) out.add(kind as ReloadBlocker)
  if (!p.hidden && p.focused && !p.focused.exempt && holdsText(p.focused)) out.add('typing')
  // Kept while hidden: text sitting in a field is lost whether you're looking or not.
  if (p.fields.some(holdsUnsavedText)) out.add('edit')
  if (p.dialogOpen) out.add('dialog')
  return out
}

// gathering the facts (DOM)

const FIELDS = 'textarea, input, [contenteditable]:not([contenteditable="false"])'
const EXEMPT = '#composer, .xterm-helper-textarea'
const DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"], dialog[open]'

function factsOf(el: Element): FieldFacts | null {
  const exempt = el.closest(EXEMPT) !== null
  if (el instanceof HTMLTextAreaElement) {
    return { kind: 'textarea', text: el.value, readOnly: el.readOnly, disabled: el.disabled, exempt }
  }
  if (el instanceof HTMLInputElement) {
    return { kind: 'input', type: el.type, text: el.value, readOnly: el.readOnly, disabled: el.disabled, exempt }
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return { kind: 'editable', text: el.textContent ?? '', exempt }
  }
  return null
}

/** The blockers on the page now. `hidden`: the window is in the background, so a focused field alone doesn't count. */
export function reloadBlockers(opts: { hidden?: boolean } = {}): Set<ReloadBlocker> {
  const guards = [...document.querySelectorAll('[data-reload-guard]')].map((el) => el.getAttribute('data-reload-guard') ?? '')
  const fields: FieldFacts[] = []
  for (const el of document.querySelectorAll(FIELDS)) {
    // Only what is on screen: a field under display:none (a parked page) has no boxes.
    if (el.getClientRects().length === 0) continue
    const f = factsOf(el)
    if (f) fields.push(f)
  }
  return blockersOf({
    guards,
    focused: document.activeElement ? factsOf(document.activeElement) : null,
    fields,
    dialogOpen: document.querySelector(DIALOG) !== null,
    hidden: opts.hidden ?? false,
  })
}
