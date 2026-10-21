/**
 * What the browser tools may do without asking (.docs/browser.md). Reading
 * the page and acting on it is the point of the feature, so those never
 * prompt; going to a site that isn't on this machine, and running arbitrary
 * script, do, unless the session already runs without prompts.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BROWSER_SERVER = 'browser'
export const browserTool = (leaf: string) => `mcp__${BROWSER_SERVER}__${leaf}`

/** Is this URL on this machine (a dev server, a local file inside the project)? */
export function isLocalUrl(raw: string, projectRoot?: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol === 'file:') {
    if (!projectRoot) return false
    let p: string
    try {
      p = fileURLToPath(u)
    } catch {
      return false
    }
    const rel = path.relative(path.resolve(projectRoot), path.resolve(p))
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol === 'about:'
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/.test(h)
  )
}

/**
 * Is the URL something `browser_open` should even try? Bare paths and host:port
 * are completed against the last page (or localhost); `javascript:` and
 * `data:` never load.
 */
export function resolveUrl(raw: string, current?: string): string | null {
  const s = raw.trim()
  if (!s) return null
  if (/^(javascript|data|vbscript|chrome|devtools):/i.test(s)) return null
  if (/^(https?|file|about):/i.test(s)) return s
  if (s.startsWith('/')) {
    try {
      return new URL(s, current && /^https?:/.test(current) ? current : 'http://localhost/').href
    } catch {
      return null
    }
  }
  // localhost:5173/x, 127.0.0.1:3000, example.com
  if (/^[\w.-]+(:\d+)?(\/|$)/.test(s)) {
    const host = s.split(/[/:]/)[0]
    return `${isLocalUrl(`http://${host}`) ? 'http' : 'https'}://${s}`
  }
  return null
}

/**
 * Whether a browser tool call runs without a prompt. Everything but leaving
 * the machine and `browser_eval` does; those go through the session's normal
 * permission mode.
 */
export function browserCallAllowed(toolName: string, input: Record<string, unknown>, projectRoot?: string): boolean {
  if (!toolName.startsWith(`mcp__${BROWSER_SERVER}__`)) return false
  const leaf = toolName.slice(`mcp__${BROWSER_SERVER}__`.length)
  if (leaf === 'browser_eval') return false
  if (leaf === 'browser_open') {
    const url = typeof input.url === 'string' ? resolveUrl(input.url) : null
    return !!url && isLocalUrl(url, projectRoot)
  }
  return true
}

// ── logged-in sites (.docs/browser.md → Logged-in sites) ───────────────────
//
// A profile can be signed in to Gmail, Pendo, GitHub: one click there can send
// something as the user. On a page that isn't on this machine the gate
// (server/browser/gate.ts) asks before anything that may commit, and a job
// is refused it. What "may commit" means is decided here, from what the
// element is, because a uid alone says nothing.

/** An element as the gate sees it: its accessibility role and name, and a few DOM facts. */
export type ElementFacts = { role: string; name: string; tag: string; type: string; inForm: boolean; editable: boolean }

/**
 * free: it only moves around or types; commit: it may send, save or delete
 * something; unsure: no way to tell (ask); password: a password field.
 */
export type ElementVerdict = 'free' | 'commit' | 'unsure' | 'password'

/** Words a control that sends, saves or deletes carries. "Close" and "Cancel" are not among them. */
const COMMIT_WORDS =
  /\b(send|sent|post|reply|respond|comment|submit|publish|share|invite|merge|approve|reject|delete|remove|discard|trash|archive|pay|buy|purchase|order|checkout|confirm|save|create|update|apply|transfer|deploy|release|resolve|assign|schedule|accept|decline|sign|upload|import|export|like|follow|subscribe|unsubscribe|block|report|install|uninstall|revoke|grant|enable|disable|activate|deactivate|move|rename|forward)\b/i
const SEARCHY = /\b(search|find|filter|lookup|go to|jump)\b/i
const CLICKABLE = new Set(['button', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch'])

const isSearch = (el: ElementFacts) => el.role === 'searchbox' || el.type === 'search' || SEARCHY.test(el.name)

/** What clicking (or tapping) this element may do. */
export function clickVerdict(el: ElementFacts | null): ElementVerdict {
  if (!el) return 'unsure'
  const name = el.name.trim()
  const submit = el.type === 'submit' || (el.tag === 'button' && el.inForm && (el.type === '' || el.type === 'submit'))
  // A control's label is short; a long name is content (a mail's subject line, a row), not a verb.
  if (COMMIT_WORDS.test(name) && (name.length <= 40 || CLICKABLE.has(el.role) || submit)) return 'commit'
  if (el.role === 'switch') return 'commit'
  if (submit) return isSearch(el) ? 'free' : 'unsure'
  // A button that says nothing (an icon: a paper plane, a trash can) could be anything.
  if ((el.role === 'button' || el.tag === 'button') && !name) return 'unsure'
  return 'free'
}

/**
 * What pressing a key in this element may do: Enter in a form, a composer or
 * an editable box often sends; ⌘/Ctrl+Enter almost always does. Other keys move.
 */
export function keyVerdict(key: string, el: ElementFacts | null): ElementVerdict {
  const parts = key.split('+').map((p) => p.trim().toLowerCase())
  const last = parts[parts.length - 1]
  if (last !== 'enter') return 'free'
  if (parts.some((p) => p === 'meta' || p === 'cmd' || p === 'control' || p === 'ctrl')) return 'commit'
  if (!el) return 'unsure'
  if (isSearch(el)) return 'free'
  if (el.tag === 'textarea') return 'unsure'
  if (el.editable || el.inForm) return 'commit'
  return clickVerdict(el)
}

/** Typing into this element: never a password on a site off this machine. */
export function typeVerdict(el: ElementFacts | null): ElementVerdict {
  if (el && (el.type === 'password' || (el.editable && el.type !== 'text' && /\bpassword\b/i.test(el.name)))) return 'password'
  return 'free'
}

/** The host a URL is on, for a prompt: "mail.google.com". */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** An element as a person names it: its accessible name in quotes, else what it is. */
export function elementLabel(el: ElementFacts | null): string {
  if (!el) return 'an element'
  const raw = el.name.trim().replace(/\s+/g, ' ')
  const name = raw.length > 40 ? `${raw.slice(0, 39)}…` : raw
  const role = el.role && el.role !== 'generic' ? el.role : el.tag || 'element'
  return name ? `"${name}"` : `an unlabelled ${role}`
}
