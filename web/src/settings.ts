/**
 * Settings is a page: `#/settings/<tab>`, with the route as its only state.
 *
 * Any component can still open it on a specific tab, a "Fix" link on an auth
 * error opens Providers, the workspace menu opens Workspace, by calling
 * `openSettings(tab)`, which is just navigation. Closing goes back to whatever
 * was in front before settings opened (App tells us via `noteReturnHash`).
 */
export type SettingsTab =
  | 'workspace'
  | 'providers'
  | 'sources'
  | 'projects'
  | 'models'
  | 'briefs'
  | 'babysit'
  | 'approvals'
  | 'browser'
  | 'skills'
  | 'agents'
  | 'teams'
  | 'connectors'
  | 'mcp'
  | 'activity'
  | 'usage'
  | 'logs'
  | 'appearance'
  | 'themes'
  | 'sessions'
  | 'shortcuts'
  | 'phone'
  | 'about'

export type SettingsTabMeta = {
  id: SettingsTab
  label: string
  sub: string
  group: 'workspace' | 'diagnostics' | 'app'
  /** A live read-out rather than a form: it fills the pane and gets a Refresh button. */
  fill?: true
}

export const SETTINGS_TABS: ReadonlyArray<SettingsTabMeta> = [
  { id: 'workspace', label: 'Workspace', sub: 'Name, colour, and which workspace opens by default.', group: 'workspace' },
  { id: 'providers', label: 'Providers', sub: 'The agents this workspace runs on — how each signs in, and how much of its plan is left.', group: 'workspace' },
  { id: 'sources', label: 'Sources', sub: 'What feeds this inbox: GitHub repos, Slack, and the connectors a session can reach.', group: 'workspace' },
  { id: 'projects', label: 'Projects', sub: 'The local folders you work in. Sessions run in a project’s folder, and dispatch matches a work item’s repo to land there.', group: 'workspace' },
  { id: 'models', label: 'Models', sub: 'Which models the model picker offers — hide the ones you never use, or add an id Claude Code does not list yet.', group: 'workspace' },
  { id: 'approvals', label: 'Approvals', sub: 'Sends Junior may make without asking each time — who, what and when. Revoke any of them here.', group: 'workspace' },
  { id: 'browser', label: 'Browser', sub: 'Profiles keep separate logins. Junior uses the one you name.', group: 'workspace' },
  { id: 'babysit', label: 'Babysit', sub: 'Junior keeps your PRs green: on or off, the models it uses, and what it may spend.', group: 'workspace' },
  { id: 'briefs', label: 'Briefs', sub: 'How briefs run: the daily cap, the model, and the playbook for each kind of work item.', group: 'workspace' },
  { id: 'skills', label: 'Skills', sub: 'Every skill a session here can use — this workspace’s, yours, each project’s, and your plugins’. Edits are live in open sessions.', group: 'workspace', fill: true },
  { id: 'agents', label: 'Agents', sub: 'Every subagent a chat here can hand work to. Edits are live in open chats.', group: 'workspace', fill: true },
  // 'teams' stays in the type but is unlisted while the teams UI is hidden (the engine stays); old links open Workspace.
  { id: 'connectors', label: 'Connectors', sub: 'What a dispatched session can reach — claude.ai connectors and local MCP servers.', group: 'workspace', fill: true },
  { id: 'mcp', label: 'MCP', sub: 'How another agent — Claude Code, Codex, Cursor — connects to this inbox from outside triage.', group: 'workspace' },
  { id: 'activity', label: 'Activity', sub: 'Recent job runs in this workspace — what ran, when, and what it filed.', group: 'diagnostics', fill: true },
  { id: 'usage', label: 'Usage', sub: 'What Claude Code has cost on this machine — tokens, spend, and where they went.', group: 'diagnostics', fill: true },
  { id: 'logs', label: 'Logs', sub: 'The daemon’s log, filterable by level and subsystem.', group: 'diagnostics', fill: true },
  { id: 'appearance', label: 'Appearance', sub: 'Theme and text size — how this browser renders the workbench.', group: 'app' },
  { id: 'themes', label: 'Themes', sub: 'Colour themes for the workbench — one for dark mode, one for light.', group: 'app' },
  { id: 'sessions', label: 'Chats', sub: 'Defaults for every new chat started from this browser.', group: 'app' },
  { id: 'shortcuts', label: 'Shortcuts', sub: 'Every key the workbench answers to.', group: 'app' },
  { id: 'phone', label: 'Phone', sub: 'Use triage from your phone — on the same Wi-Fi, or from anywhere. Pair it with a QR code.', group: 'app' },
  { id: 'about', label: 'About', sub: 'The daemon behind this page: version, ports, and where its data lives.', group: 'app' },
]

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'workspace'

export const isSettingsTab = (v: unknown): v is SettingsTab =>
  typeof v === 'string' && SETTINGS_TABS.some((t) => t.id === v)

/** A tab's id from before it was renamed, for links that still name it. */
export const LEGACY_SETTINGS_TABS: Readonly<Record<string, SettingsTab>> = { auth: 'providers' }

/** The settings page on a tab: `/#/settings/providers`. */
export const settingsHash = (tab: SettingsTab) => `/settings/${tab}`

/** The last tab shown, so the gear reopens where you were. */
let lastTab: SettingsTab = DEFAULT_SETTINGS_TAB
/** The page settings was opened from, where Close and Esc go. */
let returnHash = '/inbox'

/** App calls this for every non-settings route, so Close knows where to land. */
export function noteReturnHash(hash: string) {
  returnHash = hash || '/inbox'
}

/** App calls this when the settings route shows a tab. */
export function noteSettingsTab(tab: SettingsTab) {
  lastTab = tab
}

const onSettings = () => location.hash.slice(1).startsWith('/settings')

export function openSettings(tab: SettingsTab = lastTab) {
  const hash = settingsHash(tab)
  if (location.hash.slice(1) === hash) return
  // Hopping between tabs replaces; arriving from a page is a history entry, so Back leaves.
  if (onSettings()) location.replace(`#${hash}`)
  else location.hash = hash
}

export function closeSettings() {
  if (onSettings()) location.hash = returnHash
}

export const setSettingsTab = (tab: SettingsTab) => openSettings(tab)
