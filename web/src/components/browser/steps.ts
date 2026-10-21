/**
 * What Junior is doing in the browser, in the driving strip's words: the last
 * browser call in the session's log. Pure, so it is tested.
 */
import { isToolUseBlock, type SessionEvent } from '../../../../shared/protocol.js'

const hostOf = (url: unknown) => {
  if (typeof url !== 'string') return 'a page'
  try {
    return new URL(/^[a-z]+:\/\//i.test(url) ? url : `http://${url.replace(/^\//, 'localhost/')}`).host || url
  } catch {
    return url
  }
}

/** What a browser call is doing, in the strip's words. */
export function stepOf(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'browser_open':
      return `Opening ${hostOf(input.url)}`
    case 'browser_snapshot':
    case 'browser_extract':
      return 'Reading the page'
    case 'browser_screenshot':
      return 'Taking a screenshot'
    case 'browser_logs':
      return 'Checking the console'
    case 'browser_compare':
      return 'Comparing with the before shot'
    case 'browser_checkpoint':
      return 'Saving a before shot'
    case 'browser_viewport':
      return typeof input.size === 'string' ? `Resizing to ${input.size}` : 'Resizing the page'
    case 'browser_inspect':
      return 'Inspecting an element'
    case 'browser_eval':
      return 'Running a script'
    case 'browser_wait':
      return 'Waiting for the page'
    case 'browser_fill':
      return 'Filling in a form'
    case 'browser_profiles':
      return 'Looking at profiles'
    case 'browser_act':
      switch (input.action) {
        case 'click':
          return 'Clicking on the page'
        case 'type':
          return 'Typing in a field'
        case 'press':
          return typeof input.text === 'string' ? `Pressing ${input.text}` : 'Pressing a key'
        case 'hover':
          return 'Pointing at an element'
        case 'scroll':
          return 'Scrolling'
        case 'select':
          return 'Choosing an option'
        case 'back':
          return 'Going back'
        case 'forward':
          return 'Going forward'
        case 'reload':
          return 'Reloading'
        case 'dialog':
          return 'Answering a dialog'
        default:
          return 'Using the page'
      }
    default:
      return 'Using the page'
  }
}

const BROWSER_PREFIX = 'mcp__browser__'

/** The last browser call in a session's log, as a step; null when it never used the browser. */
export function lastBrowserStep(events: readonly SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.kind !== 'sdk' || ev.message.type !== 'assistant') continue
    const blocks = ev.message.message?.content ?? []
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j]
      if (isToolUseBlock(b) && b.name.startsWith(BROWSER_PREFIX)) return stepOf(b.name.slice(BROWSER_PREFIX.length), b.input)
    }
  }
  return null
}
