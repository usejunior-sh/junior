/**
 * Land on what waits: a Needs-you row asks for it before it opens the
 * session, and that session's transcript scrolls to the card waiting for
 * your OK (a permission prompt, a question, a held send) once it has
 * rendered, and flashes it. One request at a time; it lapses if the card
 * never shows up.
 */

/** The cards that wait on you in a transcript, oldest first. */
export const WAITING_CARDS = '.perm:has(.actions), .perm.ask:has(.askOptions), .astub.need'

/** How long a request waits for its transcript to load and render. */
const LAPSE_MS = 15_000

let pending: { sessionId: string; at: number } | null = null
let asks = 0
const listeners = new Set<() => void>()

/** Ask, then open `sessionId`: its transcript lands on the waiting card, even one open already. */
export function askFocusWaiting(sessionId: string): void {
  pending = { sessionId, at: Date.now() }
  asks++
  for (const l of listeners) l()
}

/** For useSyncExternalStore: a transcript already open hears a new ask. */
export function subscribeFocusWaiting(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
export const focusWaitingAsks = (): number => asks

/** A request for this session that hasn't lapsed. */
export function wantsFocusWaiting(sessionId: string, now = Date.now()): boolean {
  if (pending && now - pending.at > LAPSE_MS) pending = null
  return pending?.sessionId === sessionId
}

/** The bits of the DOM this needs, so it type-checks and tests without one. */
type Card = {
  scrollIntoView(o: { block: 'center' }): void
  classList: { add(c: string): void; remove(c: string): void }
  readonly offsetWidth: number
  addEventListener(type: 'animationend', fn: () => void, o: { once: true }): void
}
type Root = { querySelector(sel: string): Card | null }

/**
 * Scroll `root`'s first waiting card into view and flash it. False when
 * there is none yet, and the request stays for the next render.
 */
export function focusWaitingIn(sessionId: string, root: Root | null): boolean {
  if (!wantsFocusWaiting(sessionId) || !root) return false
  const card = root.querySelector(WAITING_CARDS)
  if (!card) return false
  pending = null
  // At once, not smooth: a commit mid-scroll would follow the bottom again.
  card.scrollIntoView({ block: 'center' })
  card.classList.remove('waitFlash')
  void card.offsetWidth
  card.classList.add('waitFlash')
  card.addEventListener('animationend', () => card.classList.remove('waitFlash'), { once: true })
  return true
}

type ToolUseBlock = { type: string; id?: unknown }
type SdkLike = { kind: string; message?: { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } } }

/**
 * Where a held call sits: the subagent calls from the main transcript down
 * to the one that made it. [] = main made it. null = none of `calls` is in
 * the events held yet (an older page). A call a subagent made shows only in
 * that subagent's view, so landing on it means opening each of these first.
 */
export function heldCallPath(events: readonly unknown[], calls: readonly string[]): string[] | null {
  const parent = new Map<string, string | null>()
  for (const ev of events as readonly SdkLike[]) {
    const m = ev?.kind === 'sdk' ? ev.message : undefined
    if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) continue
    for (const b of m.message.content as ToolUseBlock[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') parent.set(b.id, m.parent_tool_use_id ?? null)
    }
  }
  const call = calls.find((c) => parent.has(c))
  if (!call) return null
  const path: string[] = []
  for (let up = parent.get(call) ?? null; up && !path.includes(up); up = parent.get(up) ?? null) path.unshift(up)
  return path
}

/**
 * What a transcript showing `scope` (null = main) does next for a held call
 * at `path`: look for the card here, open the next subagent down, or
 * nothing (the call sits in a view this one isn't over).
 */
export function nextStep(path: readonly string[], scope: string | null): { look: true } | { open: string } | null {
  const at = scope === null ? -1 : path.indexOf(scope)
  if (scope !== null && at === -1) return null
  const next = path[at + 1]
  return next === undefined ? { look: true } : { open: next }
}

/** A Needs-you row's click where the session opens as a page: go there, landing on what waits. */
export function openNeed(row: { target: { id: string } }, onNavigate: (hash: string) => void): void {
  askFocusWaiting(row.target.id)
  onNavigate(row.target.id)
}
