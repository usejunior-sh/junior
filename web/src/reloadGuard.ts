/**
 * What on screen an automatic reload would cost you
 * (.docs/overnight-2026-10-24/designs/reload-on-build-change.md §3, "Busy").
 *
 * A component holding something in flight marks its root with
 * `data-reload-guard="<kind>"` while it is true (PromptBox with text or an
 * attachment, a card waiting on you, an editor with unsaved text). The rest is
 * read off the page itself: a text field you're typing in, an open dialog, and
 * a safety net for every editor that never marked itself: a textarea or
 * contenteditable on screen that you typed text into since the page loaded
 * counts as an unsaved edit, focused or not, window visible or not. Most of
 * those editors keep nothing in storage, so a reload would drop the text.
 *
 * What the safety net leaves alone, so the quiet reload isn't held for nothing
 * and the confirm never claims an edit that isn't there:
 * - text you didn't type: a form opened on saved values, a log, the browser's
 *   address (prefilled fields are not edits);
 * - single-line inputs out of focus: settings fields save on blur, and filters
 *   and searches are no edit (a focused one still counts as typing);
 * - anything under `data-reload-exempt`: the browser's address and find fields,
 *   a field that saves on blur, xterm's helper textarea;
 * - a composer under `data-draft-persisted` (PromptBox): its draft lives in
 *   localStorage, and it marks itself `draft` anyway.
 * A composer that keeps its text only in memory (the subagent composer) marks
 * itself `draft` instead.
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
  /** you typed into it since the page loaded; a value it was given (a saved setting, a URL) is not yours to lose */
  typed?: boolean
  /** under `data-reload-exempt` or `data-draft-persisted`, or xterm's helper textarea */
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
 * A field out of focus whose text a reload would drop: a textarea or
 * contenteditable you typed into, editable, not exempt. Single-line inputs
 * never count here: settings save on blur, and a filter or search isn't an
 * edit, so the confirm would say something untrue.
 */
export function holdsUnsavedText(f: FieldFacts): boolean {
  if (f.exempt || f.readOnly || f.disabled || !f.typed) return false
  if (f.kind === 'input') return false
  return holdsText(f)
}

export function blockersOf(p: PageFacts): Set<ReloadBlocker> {
  const out = new Set<ReloadBlocker>()
  for (const kind of p.guards) if (KINDS.has(kind)) out.add(kind as ReloadBlocker)
  // Only text you typed: focus resting in a field that shows a saved value loses nothing.
  if (!p.hidden && p.focused && !p.focused.exempt && p.focused.typed && holdsText(p.focused)) out.add('typing')
  // Kept while hidden: text sitting in a field is lost whether you're looking or not.
  if (p.fields.some(holdsUnsavedText)) out.add('edit')
  if (p.dialogOpen) out.add('dialog')
  return out
}

// gathering the facts (DOM)

const FIELDS = 'textarea, input, [contenteditable]:not([contenteditable="false"])'
const EXEMPT = '[data-reload-exempt], [data-draft-persisted], .xterm-helper-textarea'
const DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"], dialog[open]'

/**
 * Fields you typed into since the page loaded. `input` fires only for what you
 * type, paste or drop, never for a value React sets, so a field opened on a
 * saved value stays out until you change it. (A controlled field's
 * defaultValue can't tell: React keeps it in step with the value.)
 */
const typedInto = new WeakSet<EventTarget>()
if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => e.target && typedInto.add(e.target), { capture: true })
}

function factsOf(el: Element): FieldFacts | null {
  const exempt = el.closest(EXEMPT) !== null
  const typed = typedInto.has(el)
  if (el instanceof HTMLTextAreaElement) {
    return { kind: 'textarea', text: el.value, readOnly: el.readOnly, disabled: el.disabled, typed, exempt }
  }
  if (el instanceof HTMLInputElement) {
    return { kind: 'input', type: el.type, text: el.value, readOnly: el.readOnly, disabled: el.disabled, typed, exempt }
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    return { kind: 'editable', text: el.textContent ?? '', typed, exempt }
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
