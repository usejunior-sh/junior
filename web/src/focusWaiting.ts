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

/**
 * Scroll `root`'s first waiting card into view and flash it. False when
 * there is none yet, and the request stays for the next render.
 */
export function focusWaitingIn(sessionId: string, root: Element | null): boolean {
  if (!wantsFocusWaiting(sessionId) || !root) return false
  const card = root.querySelector<HTMLElement>(WAITING_CARDS)
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

/** A Needs-you row's click where the session opens as a page: go there, landing on what waits. */
export function openNeed(row: { target: { id: string } }, onNavigate: (hash: string) => void): void {
  askFocusWaiting(row.target.id)
  onNavigate(row.target.id)
}
