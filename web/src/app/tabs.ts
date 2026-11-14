import { Terminal as TerminalIcon, FileText, FileDiff, CalendarClock, ListChecks, GitPullRequest, Settings, Home, type LucideProps } from 'lucide-react'
import type { ComponentType } from 'react'
import type { RailSection } from '../components/Rail.js'
import type { TabKind } from '../components/TabBand.js'
import type { Route } from '../hooks.js'
import type { Place } from './tabKeys.js'

export { JUNIOR_TAB, PLACE_LABEL, isPlaceKey, placeKey, placeOfKey, routeOfKey, tabKeyOf } from './tabKeys.js'

/** A place's mark in its tab. */
export const PLACE_ICON: Record<Place, ComponentType<LucideProps>> = {
  inbox: ListChecks,
  prs: GitPullRequest,
  artifacts: FileText,
  jobs: CalendarClock,
  settings: Settings,
  terminals: TerminalIcon,
  changes: FileDiff,
  junior: Home,
}

/** The sections whose list is the panel: on a phone, their bottom-bar tab opens it as a sheet. */
export const MOBILE_SHEETS: readonly RailSection[] = ['agents', 'inbox', 'sessions', 'terminals', 'changes']
export const SHEET_LABEL: Record<RailSection, string> = {
  junior: 'Junior',
  agents: 'Agents',
  inbox: 'Tasks',
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

/** Things whose tab is named from a store (or remembered), not from a live session or shell. */
const DOC_KINDS: readonly TabKind[] = ['item', 'artifact', 'job', 'job-form', 'change', 'run', 'dm']

export function kindOfKey(key: string): TabKind | null {
  const cut = key.indexOf(':')
  // A session is the one key with no prefix.
  if (cut === -1) return 'session'
  const p = key.slice(0, cut)
  if (p === 'term') return 'terminal'
  if (p === 'draft') return 'draft'
  if (p === 'page') return 'place'
  return DOC_KINDS.includes(p as TabKind) ? (p as TabKind) : null
}

/** A document tab: named by useDocumentTabs from its store. */
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
  run: 'Team run',
  place: 'Page',
  dm: 'Agent',
}

/**
 * Which rail section a route belongs to: the rail's highlight, and the key
 * rail memory is filed under.
 */
export function sectionOf(route: Route): RailSection | null {
  switch (route.page) {
    case 'junior':
      return 'junior'
    case 'agents':
      return 'agents'
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
    case 'prs':
      return 'inbox'
    case 'goals':
      return 'goals'
    case 'settings':
      return null
  }
}
