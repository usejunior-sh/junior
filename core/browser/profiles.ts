/**
 * Browser profiles (.docs/browser.md → Profiles): separate cookie jars, like
 * Chrome's. The list is the daemon's, machine-wide (`browser-profiles.json`
 * under JUNIOR_HOME); the jars are Junior.app's, one Electron partition per
 * profile. The partition is a pure function of the id, so the two can never
 * disagree: a profile whose jar was never made is just signed out.
 *
 * Pure and browser-safe: shared by server and web.
 */

export const BROWSER_PROFILE_COLORS = ['gray', 'blue', 'green', 'amber', 'red', 'violet'] as const
export type BrowserProfileColor = (typeof BROWSER_PROFILE_COLORS)[number]

export type BrowserProfile = {
  /** 'default' or a slug; never changes, it names the cookie jar */
  id: string
  /** "Work", "Pendo", "Test user": unique, case-insensitive */
  name: string
  color: BrowserProfileColor
  createdAt: number
  lastUsedAt: number | null
  /**
   * The sites it had saved logins for, the last time Junior.app was asked
   * (persistent cookies, most first), and when: so the list reads with the app closed.
   */
  sites?: string[]
  sitesAt?: number
}

export const DEFAULT_PROFILE = 'default'
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const PROFILE_NAME_MAX = 40

/** The tab key of a profile's sign-in tab in Settings: no session, no tools. */
export const SIGNIN_TAB_PREFIX = 'profile-'
export const signinTabKey = (id: string) => `${SIGNIN_TAB_PREFIX}${id}`
export const profileOfSigninTab = (tabKey: string): string | null =>
  tabKey.startsWith(SIGNIN_TAB_PREFIX) && PROFILE_ID_RE.test(tabKey.slice(SIGNIN_TAB_PREFIX.length)) ? tabKey.slice(SIGNIN_TAB_PREFIX.length) : null

/** The Electron partition a profile's tabs live in. Default keeps the jar every login so far was made in. */
export const partitionOf = (id: string): string => (id === DEFAULT_PROFILE ? 'persist:junior-browser' : `persist:junior-profile-${id}`)

export const isProfileColor = (v: unknown): v is BrowserProfileColor => BROWSER_PROFILE_COLORS.includes(v as BrowserProfileColor)

export function defaultProfile(now = 0): BrowserProfile {
  return { id: DEFAULT_PROFILE, name: 'Default', color: 'gray', createdAt: now, lastUsedAt: null }
}

/** A fresh id for a name: its slug, made unique with -2, -3… */
export function profileIdFor(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'profile'
  const base = slug === DEFAULT_PROFILE ? 'default-1' : slug
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

/** A name a profile may take: trimmed, 1–40 chars, not another profile's (case-insensitive). Returns the error, or null. */
export function profileNameError(name: string, list: readonly BrowserProfile[], selfId?: string): string | null {
  const n = name.trim()
  if (!n) return 'A profile needs a name.'
  if (n.length > PROFILE_NAME_MAX) return `Keep the name under ${PROFILE_NAME_MAX + 1} characters.`
  if (list.some((p) => p.id !== selfId && p.name.toLowerCase() === n.toLowerCase())) return `There is already a profile called "${n}".`
  return null
}

/** A profile by id or by name, case-insensitive. */
export function findProfile(list: readonly BrowserProfile[], ref: string): BrowserProfile | null {
  const r = ref.trim().toLowerCase()
  if (!r) return null
  return list.find((p) => p.id === r) ?? list.find((p) => p.name.toLowerCase() === r) ?? null
}

// Second-level suffixes common enough to matter for "which site is this cookie for".
const TWO_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or'])

/**
 * The site a cookie domain belongs to, near enough to eTLD+1 to group a
 * profile's cookies: ".mail.google.com" → "google.com", "x.co.uk" → "x.co.uk".
 * IP addresses and localhost stay as they are.
 */
export function siteOf(cookieDomain: string): string {
  const h = cookieDomain.trim().toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  if (!h || h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const tld = parts[parts.length - 1]
  const sld = parts[parts.length - 2]
  const keep = tld.length === 2 && TWO_LEVEL.has(sld) ? 3 : 2
  return parts.slice(-keep).join('.')
}

/**
 * Whether a URL's host is inside a site list: "app.pendo.io" is that host,
 * "*.pendo.io" is any subdomain of it (and pendo.io itself). An empty list
 * allows everything.
 */
export function hostAllowed(sites: readonly string[] | undefined, url: string): boolean {
  if (!sites?.length) return true
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return sites.some((s) => {
    const p = s.trim().toLowerCase()
    if (p.startsWith('*.')) {
      const root = p.slice(2)
      return host === root || host.endsWith(`.${root}`)
    }
    return host === p
  })
}
