/**
 * The page tabs' rules, as keys (pure, so tests read it). Two kinds of tab:
 *
 * - a *thing* gets a tab of its own: Junior's DM, an agent's DM, a chat or
 *   thread, a work item or PR, an artifact, a run, a job, a changed file, a
 *   terminal, a draft. Its key is a session id, or `<kind>:<id>`.
 * - a *place* (Tasks, PRs, Artifacts, Jobs, Settings…) shares the one preview
 *   tab, replaced by the next place, until a double-click or starting work in
 *   it keeps it. Its key is `page:<place>`.
 *
 * Junior's DM is the one tab always there: first, icon-only, never closed.
 */

/** The parts of a route (hooks.ts `Route`) a tab key reads. Its own type, so tests need no browser. */
export type TabRoute =
  | { page: 'home' | 'goals' | 'inbox' | 'prs' | 'artifacts' | 'jobs' | 'settings' | 'terminals' | 'changes' }
  | { page: 'junior'; tab?: string }
  | { page: 'agents'; name?: string }
  | { page: 'session' | 'draft' | 'terminal' | 'item' | 'artifact' | 'job'; id: string }
  | { page: 'job-form'; id: string | null }
  | { page: 'run'; runId: string; path?: string }
  | { page: 'change'; checkoutId: string; path: string }

const JUNIOR_DM = 'junior'

/** Junior's DM: the pinned first tab. */
export const JUNIOR_TAB = `dm:${JUNIOR_DM}`

export type Place = 'inbox' | 'prs' | 'artifacts' | 'jobs' | 'settings' | 'terminals' | 'changes' | 'junior'

export const PLACE_LABEL: Record<Place, string> = {
  inbox: 'Tasks',
  prs: 'Pull requests',
  artifacts: 'Artifacts',
  jobs: 'Jobs',
  settings: 'Settings',
  terminals: 'Terminals',
  changes: 'Changes',
  junior: 'Junior’s page',
}

export const placeKey = (p: Place) => `page:${p}`
export const isPlaceKey = (key: string) => key.startsWith('page:') && key.slice(5) in PLACE_LABEL
export const placeOfKey = (key: string): Place | null => (isPlaceKey(key) ? (key.slice(5) as Place) : null)

/**
 * The tab key for a route. `team` is the team layout, where `#/junior` is
 * Junior's DM; in the classic layout it is Junior's page, a place.
 * Null only for `home` and `goals`, which redirect.
 */
export function tabKeyOf(route: TabRoute, team: boolean): string | null {
  switch (route.page) {
    case 'junior':
      return team && !route.tab ? JUNIOR_TAB : placeKey('junior')
    case 'agents':
      return `dm:${route.name ?? JUNIOR_DM}`
    case 'session':
      return route.id
    case 'draft':
      return `draft:${route.id}`
    case 'terminal':
      return `term:${route.id}`
    case 'item':
      return `item:${route.id}`
    case 'artifact':
      return `artifact:${route.id}`
    case 'run':
      return `run:${route.runId}`
    case 'job':
      return `job:${route.id}`
    case 'job-form':
      return `job-form:${route.id ?? 'new'}`
    case 'change':
      return `change:${route.checkoutId}/${encodeURIComponent(route.path)}`
    case 'inbox':
    case 'prs':
    case 'artifacts':
    case 'jobs':
    case 'settings':
    case 'terminals':
    case 'changes':
      return placeKey(route.page)
    case 'home':
    case 'goals':
      return null
  }
}

/** The route a tab key points back at, the inverse of `tabKeyOf`. */
export function routeOfKey(key: string, team: boolean): string {
  if (key === JUNIOR_TAB) return team ? '/junior' : `/agents/${JUNIOR_DM}`
  const cut = key.indexOf(':')
  const id = cut === -1 ? '' : key.slice(cut + 1)
  switch (cut === -1 ? '' : key.slice(0, cut)) {
    case 'term':
      return `/terminal/${id}`
    case 'draft':
      return `/new/${id}`
    case 'item':
      return `/item/${encodeURIComponent(id)}`
    case 'artifact':
      return `/artifact/${id}`
    case 'run':
      return `/run/${id}/plan.md`
    case 'job':
      return `/jobs/${encodeURIComponent(id)}`
    case 'job-form':
      return id === 'new' ? '/jobs/new' : `/jobs/${encodeURIComponent(id)}/edit`
    case 'change':
      return `/change/${id}`
    case 'dm':
      return `/agents/${encodeURIComponent(id)}`
    case 'page':
      return id === 'settings' ? '/settings' : `/${id}`
    default:
      // a bare session id
      return key
  }
}

/**
 * A key the band no longer understands: the old pinned `inbox` and `junior`
 * keys, from before Tasks became a place and Junior a pinned tab.
 */
export const isLegacyKey = (key: string) => key === 'inbox' || key === 'junior'

