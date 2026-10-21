import { Terminal as TerminalIcon, FileText, FileDiff, CalendarClock, Target } from 'lucide-react'
import { changeId } from '../changesStore.js'
import type { RailSection } from '../components/Rail.js'
import type { PageTab, TabKind } from '../components/TabBand.js'
import { runFileHash } from '../components/RunFolderPage.js'
import { goalHash } from '../goals.js'
import { type Route, itemHash } from '../hooks.js'

export const PAGE_TABS: Record<'jobs' | 'terminals' | 'artifacts' | 'changes' | 'goals', PageTab> = {
  terminals: { key: 'page:terminals', label: 'Terminals', icon: TerminalIcon },
  artifacts: { key: 'page:artifacts', label: 'Artifacts', icon: FileText },
  changes: { key: 'page:changes', label: 'Changes', icon: FileDiff },
  jobs: { key: 'page:jobs', label: 'Jobs', icon: CalendarClock },
  goals: { key: 'page:goals', label: 'Goals', icon: Target },
}

/** The sections whose list is the panel: on a phone, their bottom-bar tab opens it as a sheet. */
export const MOBILE_SHEETS: readonly RailSection[] = ['inbox', 'sessions', 'terminals', 'changes']
export const SHEET_LABEL: Record<RailSection, string> = {
  junior: 'Junior',
  inbox: 'Inbox',
  sessions: 'Chats',
  artifacts: 'Artifacts',
  changes: 'Changes',
  terminals: 'Terminals',
  jobs: 'Jobs',
  actions: 'Actions',
  goals: 'Goals',
}

export const termKey = (id: string) => `term:${id}`
export const draftKey = (id: string) => `draft:${id}`
export const draftRoute = (id: string) => `/new/${id}`

/**
 * The tab-band key for a route, or null when the route is not a tab at all
 * (`home` redirects, `settings` is a page of its own, outside the band). Sessions keep the bare id they
 * have always had; everything else is `<kind>:<id>`.
 */
export function tabKeyOf(route: Route): string | null {
  switch (route.page) {
    case 'junior':
      return 'junior'
    case 'inbox':
      return 'inbox'
    case 'session':
      return route.id
    case 'draft':
      return draftKey(route.id)
    case 'terminal':
      return termKey(route.id)
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
    case 'goal':
      return `goal:${route.id}`
    case 'change':
      return `change:${changeId(route.checkoutId, route.path)}`
    case 'changes':
    case 'artifacts':
    case 'jobs':
    case 'terminals':
    case 'goals':
      return PAGE_TABS[route.page].key
    case 'home':
    case 'settings':
      return null
  }
}

/** The route a tab key points back at, the inverse of `tabKeyOf`. */
export function routeOfKey(key: string): string {
  const cut = key.indexOf(':')
  const id = cut === -1 ? '' : key.slice(cut + 1)
  switch (cut === -1 ? '' : key.slice(0, cut)) {
    case 'term':
      return `/terminal/${id}`
    case 'draft':
      return draftRoute(id)
    case 'item':
      return itemHash(id)
    case 'artifact':
      return `/artifact/${id}`
    case 'run':
      return runFileHash(id)
    case 'job':
      return `/jobs/${encodeURIComponent(id)}`
    case 'job-form':
      return id === 'new' ? '/jobs/new' : `/jobs/${encodeURIComponent(id)}/edit`
    case 'change':
      return `/change/${id}`
    case 'goal':
      return goalHash(id)
    case 'page':
      return `/${id}`
    default:
      // a bare session id, or the pinned Junior and inbox
      return key === 'inbox' ? '/inbox' : key === 'junior' ? '/junior' : key
  }
}

/** Documents are peeked at; processes are pinned. */
const DOC_KINDS: readonly TabKind[] = ['item', 'artifact', 'job', 'job-form', 'change', 'goal', 'run']

export function kindOfKey(key: string): TabKind | null {
  const cut = key.indexOf(':')
  // A session is the one key with no prefix; the pinned Junior and inbox are not kinds.
  if (cut === -1) return key === 'inbox' || key === 'junior' ? null : 'session'
  const p = key.slice(0, cut)
  if (p === 'term') return 'terminal'
  if (p === 'draft') return 'draft'
  return DOC_KINDS.includes(p as TabKind) ? (p as TabKind) : null
}

/** A document is peeked at by default; a process is pinned from the start. */
export function isDocKey(key: string): boolean {
  const kind = kindOfKey(key)
  return !!kind && DOC_KINDS.includes(kind)
}

/** What a document tab is called before its store has caught up. */
export const GENERIC: Record<TabKind, string> = {
  session: 'Session',
  terminal: 'Terminal',
  draft: 'Draft',
  item: 'Work item',
  artifact: 'Artifact',
  job: 'Job',
  'job-form': 'Job',
  change: 'File',
  goal: 'Goal',
  run: 'Team run',
}

/**
 * Which rail section a route belongs to: the rail's highlight, and the key
 * rail memory is filed under.
 */
export function sectionOf(route: Route): RailSection | null {
  switch (route.page) {
    case 'junior':
      return 'junior'
    case 'inbox':
    case 'item':
      return 'inbox'
    case 'home':
    case 'session':
    case 'draft':
    case 'run':
      return 'sessions'
    case 'terminal':
    case 'terminals':
      return 'terminals'
    case 'artifact':
    case 'artifacts':
      return 'artifacts'
    case 'change':
    case 'changes':
      return 'changes'
    case 'job':
    case 'job-form':
    case 'jobs':
      return 'jobs'
    case 'goal':
    case 'goals':
      return 'goals'
    case 'settings':
      return null
  }
}
