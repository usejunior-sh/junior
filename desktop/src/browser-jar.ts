/**
 * The cookie jars behind the browser pane's tabs: one Electron partition per
 * profile (`partitionOf`). Each is set up once, before its first tab exists:
 * a Chrome user agent, what a page may ask for, where downloads go. Also the
 * profile-wide work the daemon asks for with no tab involved: which sites have
 * saved logins, clearing one site or the whole jar, and dropping a deleted
 * profile's jar (its folder goes at the next launch, when nothing holds it).
 */
import { app, session as electronSession, type Session, type WebContents } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PROFILE, partitionOf, PROFILE_ID_RE, siteOf, type DownloadState, type ProfileId, type SiteCookies } from './browser-wire.js'

/**
 * Exactly real Chrome's reduced UA: the major version only, no `Electron/x`,
 * no app token. Google refuses a sign-in from a UA that names Electron.
 */
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`
const DOWNLOAD_MAX = 500 * 1024 * 1024
const REFUSED_DOWNLOAD = /\.(app|pkg|dmg|command)$/i
/** What a page may ask for; everything else hears no (Junior owns notifications). */
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])
/** Schemes a page can never hand to another app, even on your click. */
const NEVER_EXTERNAL = /^(file|data|javascript|blob|about|chrome|devtools|http|https|ws|wss):/i
const DROPPED_FILE = 'browser-dropped.json'
/** What "clear one site" wipes besides its cookies, which go one by one. */
const SITE_STORAGES: ('filesystem' | 'indexdb' | 'localstorage' | 'serviceworkers' | 'cachestorage')[] = ['filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage']
/** How long a cookie the site meant to die with the browser lives here instead. */
const SESSION_COOKIE_KEEP_S = 30 * 24 * 3600

/**
 * ~/Downloads, spelled the way the daemon spells it (its job fence lets a run
 * read `~/Downloads/Junior/<session>`), so the two always agree, HOME included.
 */
export const downloadsDir = () => path.join(os.homedir(), 'Downloads')

/** A tab as the jars see it: whose page it is, and who is driving it right now. */
export type JarTab = { key: string; agentRecently(): boolean; userRecently(): boolean }

export type JarHooks = {
  /** the tab a page belongs to: its own view, or a sign-in window it opened */
  tabOf(wc: WebContents): JarTab | null
  download(key: string, d: { file: string; path: string; bytes: number; state: DownloadState; byAgent: boolean }): void
}

export class Jars {
  /** partitions set up so far: the ones flushed on quit */
  private readonly configured = new Set<string>()
  /** save paths handed out to downloads still running, so two of the same name don't collide */
  private readonly saving = new Set<string>()

  constructor(private readonly hooks: JarHooks) {}

  /** The profile's session, set up. Call before the first view in it: a view keeps the UA it first loaded with. */
  session(profile: ProfileId): Session {
    const partition = partitionOf(profile)
    const ses = electronSession.fromPartition(partition)
    if (this.configured.has(partition)) return ses
    this.configured.add(partition)
    // in use again: a profile recreated under a dropped id keeps its new logins
    this.undrop(profile)
    const langs = app.getPreferredSystemLanguages()
    ses.setUserAgent(CHROME_UA, langs.length ? langs.join(',') : 'en-US,en')
    ses.setPermissionRequestHandler((wc, permission, cb, details) => {
      if (permission === 'openExternal') {
        // mailto:, zoommtg:, slack:… on your click only, never during Junior's call
        const tab = this.hooks.tabOf(wc)
        const url = (details as { externalURL?: string }).externalURL ?? ''
        cb(!!tab && !tab.agentRecently() && tab.userRecently() && !!url && !NEVER_EXTERNAL.test(url))
        return
      }
      cb(ALLOWED_PERMISSIONS.has(permission))
    })
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
    this.keepSessionCookies(ses)
    ses.on('will-download', (e, item, wc) => {
      const tab = wc ? this.hooks.tabOf(wc) : null
      const byAgent = !!tab?.agentRecently()
      const name = safeFileName(item.getFilename())
      const report = (state: DownloadState, file: string, bytes: number) => {
        if (tab) this.hooks.download(tab.key, { file: path.basename(file || name), path: file, bytes, state, byAgent })
      }
      if (REFUSED_DOWNLOAD.test(name) || item.getTotalBytes() > DOWNLOAD_MAX) {
        e.preventDefault()
        report('refused', '', 0)
        return
      }
      // yours land in ~/Downloads; Junior's in a folder of the tab's own, where a job can find them
      const downloads = downloadsDir()
      const dir = byAgent && tab ? path.join(downloads, 'Junior', tab.key) : downloads
      let dest: string
      try {
        fs.mkdirSync(dir, { recursive: true })
        dest = this.freePath(dir, name)
      } catch {
        e.preventDefault()
        report('interrupted', '', 0)
        return
      }
      item.setSavePath(dest)
      let tooBig = false
      item.on('updated', () => {
        if (item.getReceivedBytes() > DOWNLOAD_MAX) {
          tooBig = true
          item.cancel()
        }
      })
      item.once('done', (_e, state) => {
        this.saving.delete(dest)
        report(tooBig ? 'refused' : state, state === 'completed' ? dest : '', item.getReceivedBytes())
      })
    })
    return ses
  }

  /**
   * A login kept in a cookie with no expiry (many SSO setups) would die with
   * the app: Electron has no "continue where you left off". So each one is set
   * again with an expiry 30 days out. The copy has an expiry, so it never
   * comes back here; removals and overwrites are left alone.
   */
  private keepSessionCookies(ses: Session) {
    let flush: NodeJS.Timeout | null = null
    ses.cookies.on('changed', (_e, c, _cause, removed) => {
      if (removed || !c.session || !c.domain) return
      const host = c.domain.replace(/^\./, '')
      void ses.cookies
        .set({
          url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
          name: c.name,
          value: c.value,
          // a host-only cookie stays host-only: naming its domain would widen it to subdomains
          ...(c.hostOnly ? {} : { domain: c.domain }),
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: Math.floor(Date.now() / 1000) + SESSION_COOKIE_KEEP_S,
        })
        .catch(() => {})
        .then(() => {
          if (flush) return
          flush = setTimeout(() => {
            flush = null
            void ses.cookies.flushStore().catch(() => {})
          }, 1000)
        })
    })
  }

  /** `name`, else `name (2)`, `name (3)`… in `dir`, not on disk and not promised to another download. */
  private freePath(dir: string, name: string): string {
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let n = 1; ; n++) {
      const p = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`)
      if (!this.saving.has(p) && !fs.existsSync(p)) {
        this.saving.add(p)
        return p
      }
    }
  }

  /** Every partition used, written to disk: a login made just before ⌘Q survives it. */
  async flush() {
    await Promise.all([...this.configured].map((p) => electronSession.fromPartition(p).cookies.flushStore().catch(() => {})))
  }

  /** The sites with cookies in a profile's jar, most cookies first. `expiresAt`: the latest expiry, ms. */
  async sites(profile: ProfileId): Promise<SiteCookies[]> {
    if (!this.exists(profile)) return []
    const by = new Map<string, SiteCookies>()
    for (const c of await this.session(profile).cookies.get({})) {
      const site = siteOf(c.domain ?? '')
      if (!site) continue
      let s = by.get(site)
      if (!s) by.set(site, (s = { site, cookies: 0, persistent: 0, expiresAt: null }))
      s.cookies += 1
      if (!c.session && c.expirationDate) {
        s.persistent += 1
        s.expiresAt = Math.max(s.expiresAt ?? 0, Math.round(c.expirationDate * 1000))
      }
    }
    return [...by.values()].sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site))
  }

  /** Sign a profile out of one site (its cookies and its origins' storage), or out of everything. → cookies removed */
  async clear(profile: ProfileId, site?: string): Promise<number> {
    if (!this.exists(profile)) return 0
    const ses = this.session(profile)
    const all = await ses.cookies.get({})
    if (!site) {
      await ses.clearStorageData()
      await ses.clearCache()
      return all.length
    }
    const mine = all.filter((c) => siteOf(c.domain ?? '') === site)
    const hosts = new Set([site, `www.${site}`])
    for (const c of mine) {
      const host = (c.domain ?? '').replace(/^\./, '')
      hosts.add(host)
      await ses.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`, c.name).catch(() => {})
    }
    // Not cookies here: an origin filter on cookies reaches past the site (localhost took 127.0.0.1's with it)
    for (const h of hosts)
      for (const scheme of ['https', 'http'])
        await ses.clearStorageData({ origin: `${scheme}://${h}`, storages: SITE_STORAGES }).catch(() => {})
    return mine.length
  }

  /** A deleted profile: wipe its jar now, remove its folder at the next launch. Default is never dropped. */
  async drop(profile: ProfileId) {
    if (profile === DEFAULT_PROFILE) throw new Error('the default profile is never dropped')
    if (!this.exists(profile)) return
    const ses = electronSession.fromPartition(partitionOf(profile))
    await ses.clearStorageData().catch(() => {})
    await ses.clearCache().catch(() => {})
    const list = readDropped()
    if (!list.includes(profile)) writeDropped([...list, profile])
    this.configured.delete(partitionOf(profile))
  }

  /**
   * The jar was ever made: set up in this run, or its folder is on disk.
   * Asking Electron for a session makes the folder, so a profile nobody has
   * used yet is answered without one.
   */
  private exists(profile: ProfileId): boolean {
    const partition = partitionOf(profile)
    return this.configured.has(partition) || fs.existsSync(path.join(app.getPath('sessionData'), 'Partitions', partition.slice('persist:'.length)))
  }

  private undrop(profile: ProfileId) {
    const list = readDropped()
    if (list.includes(profile)) writeDropped(list.filter((p) => p !== profile))
  }
}

/**
 * Remove the folders of profiles dropped in an earlier run. Before any
 * partition is touched: Electron holds a jar's files open once it's loaded.
 */
export function sweepDroppedJars() {
  const list = readDropped()
  if (!list.length) return
  const root = path.join(app.getPath('sessionData'), 'Partitions')
  const left = list.filter((id) => {
    // never the default jar, never a path out of Partitions/
    if (id === DEFAULT_PROFILE || !PROFILE_ID_RE.test(id)) return false
    try {
      fs.rmSync(path.join(root, partitionOf(id).slice('persist:'.length)), { recursive: true, force: true })
      return false
    } catch {
      return true // try again next launch
    }
  })
  writeDropped(left)
}

const droppedFile = () => path.join(app.getPath('userData'), DROPPED_FILE)

function readDropped(): string[] {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(droppedFile(), 'utf8'))
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeDropped(list: string[]) {
  try {
    if (!list.length) fs.rmSync(droppedFile(), { force: true })
    else {
      fs.mkdirSync(path.dirname(droppedFile()), { recursive: true })
      fs.writeFileSync(droppedFile(), JSON.stringify(list))
    }
  } catch {
    // the jar is already wiped; only the empty folder stays behind
  }
}

/** A download's own name, never a path: no separators, no leading dots. */
function safeFileName(raw: string): string {
  const name = path
    .basename(raw.replace(/[/\\:]/g, '_'))
    .replace(/^\.+/, '')
    .trim()
  return name || 'download'
}
