/**
 * The pane's words for addresses and failed loads (.docs/browser.md). Pure,
 * so the address field, the error page and the tests share one reading.
 */

/** What a typed address means: a scheme stays, a local host gets http, a bare path is localhost, else https. */
export function completeUrl(raw: string): string {
  const s = raw.trim()
  // "localhost:3000" looks like a scheme to a regex; a port after the colon says it's a host.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[\w.-]+:\d/.test(s)) return s
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|[\w-]+\.localhost)(?=$|[:/?#])/i.test(s)) return `http://${s}`
  if (s.startsWith('/')) return `http://localhost${s}`
  return `https://${s}`
}

export const isLocalHost = (host: string) => host === 'localhost' || host === '[::1]' || /^127\./.test(host) || host.endsWith('.localhost')

export type AddressParts = { host: string; path: string; query: boolean; mark: 'secure' | 'local' | 'insecure' | 'file' | null }

/** An address split for the field at rest: host in ink, path in ash, the query folded to "…". */
export function addressParts(url: string): AddressParts | null {
  if (!url || url === 'about:blank') return null
  try {
    const u = new URL(url)
    if (u.protocol === 'file:') return { host: '', path: decodeURI(u.pathname), query: false, mark: 'file' }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { host: url, path: '', query: false, mark: null }
    return {
      host: u.host,
      path: u.pathname === '/' ? '' : u.pathname,
      query: !!(u.search || u.hash),
      mark: isLocalHost(u.hostname) ? 'local' : u.protocol === 'https:' ? 'secure' : 'insecure',
    }
  } catch {
    return { host: url, path: '', query: false, mark: null }
  }
}

/** A URL short enough for a button: host and path, no scheme, no query. */
export function shortUrl(url: string): string {
  const p = addressParts(url)
  return p ? `${p.host}${p.path}${p.query ? '…' : ''}` : url
}

/** What the app reports for a renderer that went away, in place of a Chromium error name. */
export const PAGE_CRASHED = 'crashed'

export type PageErrorKind = 'refused-local' | 'refused' | 'dns' | 'offline' | 'cert' | 'crashed' | 'blocked' | 'other'

/** `host` is the address inside `lead`, so the page can set it in mono. */
export type PageErrorView = { kind: PageErrorKind; lead: string; line: string | null; host: string }

// Chromium's net error names (net/base/net_error_list.h) the pane words itself.
// The app sends the name; a bare number (`ERR_102`) is read the same way.
const KINDS: Record<string, PageErrorKind> = {
  ERR_CONNECTION_REFUSED: 'refused',
  ERR_CONNECTION_RESET: 'refused',
  ERR_CONNECTION_CLOSED: 'refused',
  ERR_CONNECTION_FAILED: 'refused',
  ERR_CONNECTION_TIMED_OUT: 'refused',
  ERR_ADDRESS_UNREACHABLE: 'refused',
  ERR_TIMED_OUT: 'refused',
  ERR_EMPTY_RESPONSE: 'refused',
  ERR_NAME_NOT_RESOLVED: 'dns',
  ERR_NAME_RESOLUTION_FAILED: 'dns',
  ERR_INTERNET_DISCONNECTED: 'offline',
  ERR_DISALLOWED_URL_SCHEME: 'blocked',
  ERR_UNKNOWN_URL_SCHEME: 'blocked',
  ERR_BLOCKED_BY_CLIENT: 'blocked',
}
const BY_NUMBER: Record<string, PageErrorKind> = {
  '7': 'refused', '100': 'refused', '101': 'refused', '102': 'refused', '104': 'refused', '109': 'refused', '118': 'refused', '324': 'refused',
  '105': 'dns', '137': 'dns', '106': 'offline', '20': 'blocked', '301': 'blocked', '302': 'blocked',
}

function kindOf(code: string): PageErrorKind {
  if (code === PAGE_CRASHED) return 'crashed'
  const name = code.toUpperCase()
  if (KINDS[name]) return KINDS[name]
  if (name.startsWith('ERR_CERT_') || name.startsWith('ERR_SSL_')) return 'cert'
  const n = /^ERR_-?(\d+)$/.exec(name)?.[1]
  if (n) return BY_NUMBER[n] ?? (Number(n) >= 200 && Number(n) < 300 ? 'cert' : 'other')
  return 'other'
}

/** What the stage says when a page didn't load: the app's error name, in our words. */
export function pageErrorView(code: string, url: string): PageErrorView {
  const v = errorWords(code, url)
  return { ...v, host: hostIn(url) }
}

const hostIn = (url: string) => {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function errorWords(code: string, url: string): Omit<PageErrorView, 'host'> {
  let host = url
  let local = false
  let scheme = ''
  try {
    const u = new URL(url)
    host = u.host || url
    local = isLocalHost(u.hostname)
    scheme = u.protocol.replace(/:$/, '')
  } catch {
    // keep the raw text
  }
  switch (kindOf(code)) {
    case 'crashed':
      return { kind: 'crashed', lead: 'This page crashed.', line: 'Reload to try again.' }
    case 'refused':
      return local
        ? { kind: 'refused-local', lead: `Nothing is running on ${host}.`, line: 'Start your dev server, then reload.' }
        : { kind: 'refused', lead: `${host} didn't answer.`, line: 'The site may be down. Try again in a minute.' }
    case 'dns':
      return { kind: 'dns', lead: `Can't find ${host}.`, line: 'Check the address, or your connection.' }
    case 'offline':
      return { kind: 'offline', lead: "You're offline.", line: "Reload once you're back online." }
    case 'cert':
      return { kind: 'cert', lead: "This site's certificate isn't trusted.", line: "Junior won't open it. Check the address." }
    case 'blocked':
      return { kind: 'blocked', lead: `Junior doesn't open ${scheme || 'these'}: links.`, line: null }
    default:
      return { kind: 'other', lead: `${host} didn't load.`, line: 'Reload to try again.' }
  }
}
