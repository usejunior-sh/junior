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
