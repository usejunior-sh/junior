/**
 * Should this page reload because the daemon behind it changed build?
 * (.docs/overnight-2026-10-24/designs/reload-on-build-change.md §3)
 *
 * After `npm run app:snapshot`, `junior restart` onto a new copy or `curl | sh`,
 * the socket reconnects and `hello` names the new build, but the page keeps
 * running the old bundle. These rules decide what happens then. Pure, no DOM:
 * the store asks, test/reload-on-build.test.ts walks the table.
 *
 * The page compares against the build it was loaded with (the first `hello`
 * of this page load), not the last one, so an update then a rollback lands
 * back on what the page already runs and asks for nothing.
 */
import type { Build } from '../../shared/protocol.js'

/** Written to sessionStorage just before an automatic reload: for which build, and when. */
export type ReloadMark = { key: string; at: number }

/**
 * No second automatic reload this soon after the last one. Two daemons
 * flapping on one port would otherwise bounce the page between them; past
 * this window the bar shows instead.
 */
export const RELOAD_COOLDOWN_MS = 60_000

/**
 * What identifies the bundle a page runs. The version alone misses two dirty
 * snapshots of one commit (both `1.0.4-dev.g23d0004.dirty`); the bundle's
 * hashed entry file (`ui`) catches them, and the root catches an app that
 * moved, or prod and a checkout swapping on one port.
 */
export function buildKey(b: Build): string {
  return `${b.version}|${b.root}|${b.ui ?? ''}`
}

/**
 * The daemon now serves a different UI than this page was loaded with. Never
 * in dev: Vite serves the UI there and HMR keeps it current, so a daemon
 * restart doesn't change the bundle the page runs.
 */
export function buildChanged(loaded: Build | null, next: Build): boolean {
  if (!loaded) return false
  if (next.channel === 'dev' || loaded.channel === 'dev') return false
  return buildKey(loaded) !== buildKey(next)
}

/**
 * Reload now, by itself? Only when the build changed, nothing on screen is in
 * flight (`busy`: a draft, a waiting card, an unsaved edit, an open dialog),
 * and the loop guard allows it: not for a build this tab already reloaded
 * for, and not within RELOAD_COOLDOWN_MS of the last automatic reload. When
 * it says no but the build changed, the page shows the update bar instead.
 */
export function shouldAutoReload(
  loaded: Build | null,
  next: Build,
  busy: boolean,
  last?: ReloadMark | null,
  now: number = Date.now(),
): boolean {
  if (!buildChanged(loaded, next) || busy) return false
  if (!last) return true
  return last.key !== buildKey(next) && now - last.at >= RELOAD_COOLDOWN_MS
}

/** Read back a mark from storage; anything malformed is no mark. */
export function parseReloadMark(raw: string | null): ReloadMark | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const { key, at } = v as Record<string, unknown>
    return typeof key === 'string' && typeof at === 'number' ? { key, at } : null
  } catch {
    return null
  }
}
