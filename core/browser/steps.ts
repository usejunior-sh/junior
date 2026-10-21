/**
 * What Junior is doing with the page right now, in a few words, for the
 * pane's driving strip (.docs/browser.md → The pane): "Clicking "Send"",
 * "Typing in "Email"", "Opening app.pendo.io". The daemon sets it as each
 * browser call starts, so a job run and a chat read the same.
 *
 * Pure: the element (when the call names one) is looked up by the caller.
 */
import { type ElementFacts, elementLabel, hostOf } from './policy.js'

const quote = (s: string, n = 40) => {
  const t = s.trim().replace(/\s+/g, ' ')
  return `"${t.length > n ? `${t.slice(0, n - 1)}…` : t}"`
}

/** A field without a name reads as "a field", not "an unlabelled textbox". */
const fieldLabel = (el: ElementFacts | null) => (el?.name.trim() ? elementLabel(el) : 'a field')

export function stepText(leaf: string, args: Record<string, unknown>, el: ElementFacts | null, url?: string | null): string {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  switch (leaf) {
    case 'browser_open':
      return `Opening ${hostOf(url || str('url')) || 'a page'}`
    case 'browser_snapshot':
      return str('find') ? `Looking for ${quote(str('find'))}` : 'Reading the page'
    case 'browser_screenshot':
      return el ? `Taking a screenshot of ${elementLabel(el)}` : str('target') === 'full' ? 'Taking a full-page screenshot' : 'Taking a screenshot'
    case 'browser_act':
      switch (args.action) {
        case 'click':
          return `Clicking ${elementLabel(el)}`
        case 'type':
          return `Typing in ${fieldLabel(el)}`
        case 'press':
          return `Pressing ${str('text') || 'a key'}`
        case 'hover':
          return `Pointing at ${elementLabel(el)}`
        case 'scroll':
          return 'Scrolling'
        case 'select':
          return str('text') ? `Choosing ${quote(str('text'))}` : 'Choosing an option'
        case 'back':
          return 'Going back'
        case 'forward':
          return 'Going forward'
        case 'reload':
          return 'Reloading'
        case 'dialog':
          return str('text') === 'dismiss' ? 'Dismissing the dialog' : 'Answering the dialog'
      }
      return 'Using the page'
    case 'browser_fill': {
      const n = Array.isArray(args.fields) ? args.fields.length : 0
      return n === 1 ? `Filling ${fieldLabel(el)}` : `Filling ${n} fields`
    }
    case 'browser_wait':
      return str('text') ? `Waiting for ${quote(str('text'))}${args.gone === true ? ' to go' : ''}` : str('url') ? 'Waiting for the page to change' : 'Waiting'
    case 'browser_logs':
      return 'Reading the console'
    case 'browser_viewport':
      return str('size') ? `Switching to ${str('size').trim().toLowerCase()}` : 'Changing the size'
    case 'browser_inspect':
      return `Measuring ${elementLabel(el)}`
    case 'browser_eval':
      return 'Running a script'
    case 'browser_checkpoint':
      return 'Saving a checkpoint'
    case 'browser_compare':
      return `Comparing with ${quote(str('label') || 'before')}`
    case 'browser_extract':
      return args.as === 'table' ? 'Reading a table' : args.as === 'links' ? 'Reading the links' : 'Reading the text'
  }
  return 'Using the page'
}

/** The uid a call is about, if any: whose element the step names. */
export function stepUid(leaf: string, args: Record<string, unknown>): number | null {
  if (leaf === 'browser_fill') {
    const f = Array.isArray(args.fields) && args.fields.length === 1 ? (args.fields[0] as { uid?: unknown }) : null
    return typeof f?.uid === 'number' ? f.uid : null
  }
  return typeof args.uid === 'number' ? args.uid : null
}
