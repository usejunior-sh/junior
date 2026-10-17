/**
 * Autonomy: when Junior checks in with you (.docs/junior-goals-teams/modes-autonomy-goals.md).
 * Four levels, each named by what Junior still asks about.
 *
 * The wire values are the session's PermissionMode — mostly the SDK's own
 * ('gated' is triage's, enforced server-side, and so are the extras on top of
 * 'acceptEdits' and 'auto'); only the copy lives here. Order is least to most
 * Junior does alone, which is also the Shift+Tab cycle where it cycles this.
 */
import type { PermissionMode } from '../../shared/protocol.js'

export type AutonomyLevel = {
  id: PermissionMode
  /** Menu row. */
  name: string
  /** Chip label. */
  short: string
  /** Bars lit in the chip's meter, 1–4. */
  bars: 1 | 2 | 3 | 4
  /** One line under the name. */
  description: string
  /** Drives the chip's colour: how much this level gives away. */
  risk: 'none' | 'some' | 'high'
}

export const AUTONOMY_LEVELS: AutonomyLevel[] = [
  {
    id: 'gated',
    name: 'Asks before any change',
    short: 'Asks: any change',
    bars: 1,
    description: 'Reads on its own. Every edit, command and send waits for you.',
    risk: 'none',
  },
  {
    id: 'acceptEdits',
    name: 'Asks before commands',
    short: 'Asks: commands',
    bars: 2,
    description: 'Edits files and runs read-only commands. Other commands ask.',
    risk: 'some',
  },
  {
    id: 'auto',
    name: 'Asks before sending',
    short: 'Asks: sends',
    bars: 3,
    description: 'Runs anything you can undo. Destructive commands ask; sends wait in Actions.',
    risk: 'some',
  },
  {
    id: 'bypassPermissions',
    name: 'Never asks',
    short: 'Never asks',
    bars: 4,
    description: 'Runs and sends anything without asking.',
    risk: 'high',
  },
]

/** What a new session starts at when nothing says otherwise. */
export const DEFAULT_MODE: PermissionMode = 'acceptEdits'

/** The old "Ask every time" ('default', or no mode at all) reads as the lowest level. */
export const normalizeMode = (id: PermissionMode | undefined): PermissionMode => (!id || id === 'default' ? 'gated' : id)

export function findMode(id: PermissionMode | undefined): AutonomyLevel {
  const want = normalizeMode(id)
  return AUTONOMY_LEVELS.find((m) => m.id === want) ?? AUTONOMY_LEVELS[0]
}

/**
 * The levels to offer. "Asks before sending" needs the provider's hooks to
 * hold sends and catch destructive commands (Codex has none). "Never asks" is
 * off until Settings allows it. The current level always shows, so a session
 * already there can see where it is.
 */
export function levelsFor({ hooks = true, allowNever = false, current }: { hooks?: boolean; allowNever?: boolean; current?: PermissionMode }): AutonomyLevel[] {
  const now = normalizeMode(current)
  return AUTONOMY_LEVELS.filter(
    (m) => m.id === now || ((hooks || m.id !== 'auto') && (allowNever || m.id !== 'bypassPermissions')),
  )
}

/**
 * The next level in the cycle. "Never asks" is deliberately not reachable this
 * way — a keystroke should not land you on it; that costs a trip through the menu.
 */
export function nextMode(id: PermissionMode | undefined, hooks = true): PermissionMode {
  const cycle = AUTONOMY_LEVELS.filter((m) => m.risk !== 'high' && (hooks || m.id !== 'auto'))
  const i = cycle.findIndex((m) => m.id === normalizeMode(id))
  return cycle[(i + 1) % cycle.length].id
}

/** A stored mode string is only usable if it is still a mode we know ('default' included, read as the lowest level). */
export const isPermissionMode = (v: unknown): v is PermissionMode =>
  v === 'default' || (typeof v === 'string' && AUTONOMY_LEVELS.some((m) => m.id === v))
