/**
 * Which Junior-page tab an open item sits on (plan artifact cb50520f, "Junior
 * tab": one section per reason). The page shows them as tabs; FYI is a
 * section under Suggested.
 *
 *   prs       your PR
 *   reviews   someone asked for your review
 *   people    someone asked you something (a question, changes requested)
 *   work      assigned to you, or anything you started or handed off
 *   fyi       you were mentioned; nothing is asked of you
 *
 * Your own to-dos and job finds that nobody started stay in the inbox: they
 * are backlog until you start them. Pure, browser-safe.
 */
import type { Handoff, Reason } from '../work/fields.js'
import type { ItemFlow } from '../work/flow.js'
import { isStarted } from '../work/inbox-views.js'

export type JuniorSection = 'prs' | 'reviews' | 'people' | 'work' | 'fyi'

export function sectionOf(i: { reason: Reason; handoff?: Handoff; flow?: ItemFlow; junior?: unknown }): JuniorSection | null {
  switch (i.reason) {
    case 'your-pr':
      return 'prs'
    case 'review-requested':
      return 'reviews'
    case 'asked':
      return 'people'
    case 'mentioned':
      return 'fyi'
    case 'assigned':
      return 'work'
    default:
      return i.handoff || i.junior || isStarted(i.flow) ? 'work' : null
  }
}
