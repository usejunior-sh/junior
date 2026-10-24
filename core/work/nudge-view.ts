/**
 * The words and keys of "Draft nudge?" (plan item `nudge-ui`, design note
 * .docs/overnight-2026-10-24/designs/nudge-ui.md). The Junior page's
 * Waiting rows and the item page's Needs you card read the same lines.
 *
 * Nothing here drafts or sends: the row offers, you pick Draft nudge, the
 * server drafts (server/tasks/nudge.ts), and only ⌘↩ in the box sends what
 * the box holds.
 *
 * Pure and browser-safe.
 */
import { SLACK_SEND_TOOL } from '../playbooks/send.js'
import { impactParts } from '../actions/view.js'
import { refOf } from './nudge.js'
import type { NudgeMark } from './nudge-suggest.js'

/** The suggestion on a closed row, after "Waiting 3d · ". */
export const NUDGE_ASK = 'Draft nudge?'

/** How a nudge leaves, as the editor needs it: Junior sends it, or you copy it. */
export type NudgeWay = 'send' | 'copy'

/** From the mark's route, or from what a drafted task carries ('slack-thread' or null). */
export function nudgeWay(route: NudgeMark['route'] | string | null | undefined): NudgeWay {
  if (route && typeof route === 'object') return route.send ? 'send' : 'copy'
  return route === 'slack-thread' ? 'send' : 'copy'
}

/** "Waiting 3d", the part of the state cell before the ask; `age` is the short age of the wait. */
export const nudgeWaited = (age: string): string => (age ? `Waiting ${age}` : 'Waiting')

/** What Junior says on the open row: how long, and who else waits on the same person. */
export function nudgeSays(mark: Pick<NudgeMark, 'person' | 'workingDays' | 'alsoWaiting'>): string {
  const n = Math.max(0, Math.floor(mark.workingDays))
  const head = `${mark.person} has had this ${n} working day${n === 1 ? '' : 's'}.`
  const refs = mark.alsoWaiting.map((id) => refOf(id) ?? id).filter(Boolean)
  return refs.length ? `${head} Also waiting on ${mark.person}: ${refs.join(', ')}.` : head
}

/** The impact line over the box: where it lands and as whom, or that you send it yourself. */
export function nudgeImpact(way: NudgeWay): string[] {
  if (way === 'copy') return ['You send it yourself', 'Junior sends nothing']
  return impactParts({ tool: SLACK_SEND_TOOL, args: { thread_ts: '1' } }, 'Reply in the Slack thread')
}

/** The fine print by the buttons. */
export const nudgeFine = (way: NudgeWay): string => (way === 'send' ? 'sent word for word, as you' : 'copy it and send it yourself')

/** The one line after it went out. */
export function nudgeDone(how: 'sent' | 'by-hand' | 'rule', person: string): string {
  if (how === 'rule') return 'Sent under a rule you wrote. See it in the Log.'
  const cool = `No nudge for ${person} for a day.`
  return how === 'sent' ? `Sent to ${person}. ${cool}` : `Marked sent. ${cool}`
}

export const nudgeDraftFailed = (error: string): string => `Couldn't draft the nudge: ${error}`
export const nudgeSendFailed = (error: string): string => `Didn't send: ${error}. Your text is still here.`

/** The box grows with the text: 2 to 6 rows. */
export function nudgeRows(text: string): number {
  return Math.min(6, Math.max(2, text.split('\n').length))
}

/**
 * The only send key: ⌘↩ (Ctrl↩ off a Mac). A plain ↩ is a newline, and
 * ⇧↩ / ⌥↩ never send either.
 */
export function isNudgeSendKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean }): boolean {
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.altKey) return false
  return e.metaKey || e.ctrlKey
}
