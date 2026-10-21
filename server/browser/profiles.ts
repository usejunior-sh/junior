import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type BrowserProfile,
  type BrowserProfileColor,
  DEFAULT_PROFILE,
  defaultProfile,
  findProfile,
  isProfileColor,
  PROFILE_ID_RE,
  profileIdFor,
  profileNameError,
} from '../../core/browser/profiles.js'
import { TRIAGE_DIR } from '../state.js'

/**
 * The browser profiles (.docs/browser.md → Profiles): machine-wide, owned
 * here, in `browser-profiles.json` under TRIAGE_HOME (0600). Every workspace
 * sees the same list, as every Chrome window sees the same profiles; each
 * workspace only picks its default. The cookie jars are Triage.app's, one per
 * id, so a deleted profile's jar is wiped by the app: when the app is closed
 * the wipe waits in `pendingDrops` for its next hello.
 */
type ProfilesFile = { version: 1; profiles: BrowserProfile[]; pendingDrops?: string[] }

export const PROFILES_FILE = path.join(TRIAGE_DIR, 'browser-profiles.json')
const MAX_SITES = 50

/** What a stored file holds, cleaned: Default always first, unknown fields and bad rows dropped. */
export function readProfilesFile(raw: unknown, now = Date.now()): { profiles: BrowserProfile[]; pendingDrops: string[] } {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Partial<ProfilesFile>
  const seen = new Set<string>()
  const profiles: BrowserProfile[] = []
  for (const p of Array.isArray(f.profiles) ? f.profiles : []) {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PROFILE_ID_RE.test(p.id) || seen.has(p.id)) continue
    if (typeof p.name !== 'string' || !p.name.trim()) continue
    seen.add(p.id)
    profiles.push({
      id: p.id,
      name: p.name.trim().slice(0, 40),
      color: isProfileColor(p.color) ? p.color : 'gray',
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : now,
      lastUsedAt: typeof p.lastUsedAt === 'number' ? p.lastUsedAt : null,
      ...(Array.isArray(p.sites) && typeof p.sitesAt === 'number' ? { sites: p.sites.filter((x): x is string => typeof x === 'string').slice(0, MAX_SITES), sitesAt: p.sitesAt } : {}),
    })
  }
  const def = profiles.find((p) => p.id === DEFAULT_PROFILE) ?? defaultProfile(now)
  const rest = profiles.filter((p) => p.id !== DEFAULT_PROFILE)
  const drops = Array.isArray(f.pendingDrops) ? f.pendingDrops.filter((d): d is string => typeof d === 'string' && PROFILE_ID_RE.test(d) && d !== DEFAULT_PROFILE) : []
  return { profiles: [def, ...rest], pendingDrops: [...new Set(drops)] }
}

export class BrowserProfiles {
  private profiles: BrowserProfile[]
  private pendingDrops: string[]
  /** writes in order: a rename never lands before the create it follows */
  private chain: Promise<void> = Promise.resolve()
  private readonly listeners = new Set<() => void>()

  constructor(readonly file: string = PROFILES_FILE) {
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      // missing or unreadable: just Default
    }
    const r = readProfilesFile(raw)
    this.profiles = r.profiles
    this.pendingDrops = r.pendingDrops
  }

  list(): BrowserProfile[] {
    return this.profiles.map((p) => ({ ...p }))
  }

  get(id: string): BrowserProfile | null {
    const p = this.profiles.find((x) => x.id === id)
    return p ? { ...p } : null
  }

  /** By id or by name, case-insensitive. */
  find(ref: string): BrowserProfile | null {
    const p = findProfile(this.profiles, ref)
    return p ? { ...p } : null
  }

  /** Called on every change: the routes broadcast the new list to every workspace. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async create(input: { name: string; color?: BrowserProfileColor }, now = Date.now()): Promise<BrowserProfile> {
    const err = profileNameError(input.name, this.profiles)
    if (err) throw new Error(err)
    if (input.color !== undefined && !isProfileColor(input.color)) throw new Error(`"${String(input.color)}" is not a profile colour.`)
    const p: BrowserProfile = {
      id: profileIdFor(input.name, new Set([...this.profiles.map((x) => x.id), ...this.pendingDrops])),
      name: input.name.trim(),
      color: input.color ?? 'blue',
      createdAt: now,
      lastUsedAt: null,
    }
    this.profiles = [...this.profiles, p]
    await this.save()
    return { ...p }
  }

  async update(id: string, patch: { name?: string; color?: BrowserProfileColor }): Promise<BrowserProfile> {
    const cur = this.profiles.find((p) => p.id === id)
    if (!cur) throw new Error(`No profile "${id}".`)
    if (patch.name !== undefined) {
      const err = profileNameError(patch.name, this.profiles, id)
      if (err) throw new Error(err)
    }
    if (patch.color !== undefined && !isProfileColor(patch.color)) throw new Error(`"${String(patch.color)}" is not a profile colour.`)
    const next: BrowserProfile = { ...cur, ...(patch.name !== undefined ? { name: patch.name.trim() } : {}), ...(patch.color ? { color: patch.color } : {}) }
    this.profiles = this.profiles.map((p) => (p.id === id ? next : p))
    await this.save()
    return { ...next }
  }

  /** Delete a profile. Its jar's wipe is queued until the app confirms it (`dropped`). */
  async remove(id: string): Promise<void> {
    if (id === DEFAULT_PROFILE) throw new Error('The Default profile can be cleared, not deleted.')
    if (!this.profiles.some((p) => p.id === id)) throw new Error(`No profile "${id}".`)
    this.profiles = this.profiles.filter((p) => p.id !== id)
    this.pendingDrops = [...new Set([...this.pendingDrops, id])]
    await this.save()
  }

  /** Jars still to wipe (deleted while the app was closed, or not yet confirmed). */
  drops(): string[] {
    return [...this.pendingDrops]
  }

  async dropped(id: string): Promise<void> {
    if (!this.pendingDrops.includes(id)) return
    this.pendingDrops = this.pendingDrops.filter((d) => d !== id)
    await this.save(false)
  }

  /**
   * What the app last said this profile is signed in to (sites with persistent
   * cookies, most first), so the list reads with the app closed.
   */
  async setSites(id: string, sites: { site: string; persistent: number }[], now = Date.now()): Promise<void> {
    const p = this.profiles.find((x) => x.id === id)
    if (!p) return
    const next = sites.filter((x) => x.persistent > 0).sort((a, b) => b.persistent - a.persistent).map((x) => x.site).slice(0, MAX_SITES)
    const same = JSON.stringify(next) === JSON.stringify(p.sites ?? null)
    p.sites = next
    p.sitesAt = now
    await this.save(!same)
  }

  /** A tab used this profile: kept for sorting, written at most once a minute per profile. */
  touch(id: string, now = Date.now()) {
    const p = this.profiles.find((x) => x.id === id)
    if (!p || (p.lastUsedAt && now - p.lastUsedAt < 60_000)) return
    p.lastUsedAt = now
    void this.save(false).catch(() => {})
  }

  private save(notify = true): Promise<void> {
    const body: ProfilesFile = { version: 1, profiles: this.profiles, ...(this.pendingDrops.length ? { pendingDrops: this.pendingDrops } : {}) }
    const text = JSON.stringify(body, null, 2) + '\n'
    const run = async () => {
      await mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      await writeFile(tmp, text, { mode: 0o600 })
      await rename(tmp, this.file)
      await chmod(this.file, 0o600)
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => {})
    if (notify) for (const fn of this.listeners) fn()
    return p
  }
}

let shared: BrowserProfiles | null = null

/** The daemon's one registry. */
export function browserProfiles(): BrowserProfiles {
  shared ??= new BrowserProfiles()
  return shared
}

/** Every profile, Default first. */
export const listProfiles = (): BrowserProfile[] => browserProfiles().list()
