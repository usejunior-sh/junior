import type { ActionRecord, ActionHistoryEntry } from '../../core/actions/types.js'
import type { KindCount } from '../../core/actions/count.js'

// ---------------------------------------------------------------------------
// Actions (GET /api/actions, POST /api/actions/override) — every outbound
// action a session took: a PR, a comment, a ticket, a push. Phase 1 records
// them; approval is unchanged. Domain types live in core/actions/types.ts.
// ---------------------------------------------------------------------------

export type {
  ActionActor,
  ActionAllowedBy,
  ActionHistoryEntry,
  ActionKind,
  ActionQueue,
  ActionRecord,
  ActionStatus,
  ActionWhy,
} from '../../core/actions/types.js'
export type { KindCount } from '../../core/actions/count.js'

/** A record as the page shows it: names for the ids it carries. */
export type ActionView = ActionRecord & {
  /** what happened, in words: "Opened PR #2 · stage + turn", "Pushed feat/x" (core/actions/describe.ts) */
  title: string
  /** why it counted, in words: "matches `git push`", "“send” in the tool name" */
  counted: string
  /** "a1b2c3" — the id the agent was told ("queued as action #a1b2c3") */
  short: string
  /** a queued action's steps, oldest first; absent on one recorded as it ran */
  history?: ActionHistoryEntry[]
  sessionTitle?: string
  jobTitle?: string
  /** the team run's label, for a lead's or a worker's action */
  teamLabel?: string
  itemTitle?: string
  /** the actions file now says this tool is not an action — listed only under "Not actions" */
  hidden?: boolean
}

export type ActionsResponse =
  | {
      ok: true
      actions: ActionView[]
      /** the daily count line, and the counts behind it (server's local day) */
      today: { line: string; counts: KindCount[] }
      /** the actions file, and what's wrong with it (the defaults stand in meanwhile) */
      file: { path: string; errors: string[] }
      /** queued actions waiting on you, workspace-wide */
      needsYou: number
    }
  | { ok: false; error: string }

/** The rail badge: how many queued actions wait on you. */
export type ActionsPendingResponse = { ok: true; needsYou: number } | { ok: false; error: string }

/**
 * A queued action's verbs (POST /api/actions/<verb>, phase 2):
 *   approve    `args` = edit, then approve — the edited JSON object is what goes out
 *   undo       back to waiting, inside the 15s window
 *   send-back  `notes` go to the session that drafted it
 *   reject     with an optional `reason`
 *   retry      a failed or unknown dispatch, scheduled again
 */
export type ActionVerb = 'approve' | 'undo' | 'send-back' | 'reject' | 'retry'
export type ActionMoveRequest = { id: string; args?: Record<string, unknown>; notes?: string; reason?: string }
export type ActionMoveResponse = { ok: true; action: ActionView } | { ok: false; error: string }

/**
 * One-click override from a row: `verdict: 'not_action'` adds the record's
 * tool (a connector's name, or `Bash(<pattern>)` for each pattern it counted
 * by) to `not_action`; `'action'` takes those back out, and adds a connector
 * to `action` when sorting alone wouldn't count it. `entries` = what was set.
 */
export type ActionOverrideRequest = { actionId: string; verdict: 'action' | 'not_action' }
export type ActionOverrideResponse = { ok: true; entries: string[] } | { ok: false; error: string }
