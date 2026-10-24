/**
 * An item's fields beside its ask (asks.ts): why it is here, what it is, what
 * it belongs to, and how Junior works it. No single "kind" decides all four
 * (plan artifact cb50520f, "Work items").
 *
 * - reason: where it sits on the Junior tab. Stored when a scanner, job or
 *   you set it; otherwise read off the kind (`reasonOf`).
 * - label: what it is, for you. Junior suggests, you change.
 * - parent: the epic it belongs to. Two levels at most.
 * - playbook: how Junior works it, and so which tasks it gets.
 *
 * Memory (plan · decisions) lives on the item too: every task reads it and
 * writes back to it, so a fresh session per task still knows the story.
 */
import type { ItemKind, WorkItem } from './types.js'

export type Reason = 'your-pr' | 'review-requested' | 'asked' | 'assigned' | 'mentioned' | 'you-added' | 'found'
export const REASONS: readonly Reason[] = ['your-pr', 'review-requested', 'asked', 'assigned', 'mentioned', 'you-added', 'found']

/**
 * `friction` is yours alone: something in Junior annoyed you, noted with one
 * key (⌘⇧.) to fix later. Jobs can't file it (core/job/filing.ts).
 */
export type ItemLabel = 'bug' | 'improvement' | 'question' | 'feature' | 'idea' | 'friction'
export const ITEM_LABELS: readonly ItemLabel[] = ['bug', 'improvement', 'question', 'feature', 'idea', 'friction']

export type Playbook = 'babysit' | 'review' | 'answer' | 'debug-fix' | 'investigate' | 'plan'
export const PLAYBOOKS: readonly Playbook[] = ['babysit', 'review', 'answer', 'debug-fix', 'investigate', 'plan']

export interface Decision {
  at: number
  by: 'you' | 'junior'
  text: string
  /** the task that made it, when one did */
  taskId?: string
}

export interface ItemMemory {
  /** the current plan, markdown; replaced, not appended */
  plan?: string
  /** append-only, oldest first */
  decisions: Decision[]
}

/**
 * Whether you handed the item to Junior (Phase 1, artifact f335b876): on, or
 * paused. Absent = never handed off: Junior suggests, it doesn't touch.
 */
export type Handoff = 'on' | 'paused'
export const isHandoff = (v: unknown): v is Handoff => v === 'on' || v === 'paused'

export const isReason = (v: unknown): v is Reason => typeof v === 'string' && (REASONS as readonly string[]).includes(v)
export const isItemLabel = (v: unknown): v is ItemLabel => typeof v === 'string' && (ITEM_LABELS as readonly string[]).includes(v)
export const isPlaybook = (v: unknown): v is Playbook => typeof v === 'string' && (PLAYBOOKS as readonly string[]).includes(v)

const KIND_TO_REASON: Record<ItemKind, Reason> = {
  'own-pr-open': 'your-pr',
  'own-pr-approved': 'your-pr',
  'own-pr-conflicting': 'your-pr',
  'own-pr-stale': 'your-pr',
  'review-requested': 'review-requested',
  'reply-needed': 'asked',
  'slack-reply-pending': 'asked',
  'ticket-assigned': 'assigned',
  mention: 'mentioned',
  'slack-mention': 'mentioned',
  fyi: 'mentioned',
  manual: 'you-added',
  // you said it; Junior filed it: the work is yours to do
  promise: 'assigned',
  'job-hit': 'found',
  digest: 'found',
}

/** Why an item is here: what was stored, else its kind's. */
export function reasonOf(item: Pick<WorkItem, 'kind' | 'reason'>): Reason {
  return isReason(item.reason) ? item.reason : (KIND_TO_REASON[item.kind] ?? 'found')
}

/** Most decisions a prompt quotes; older ones stay on the item. */
export const MEMORY_DECISIONS_IN_PROMPT = 20

/** The item's memory as a prompt section, or '' when there is none. */
export function memoryBlock(memory: ItemMemory | undefined): string {
  if (!memory || (!memory.plan && memory.decisions.length === 0)) return ''
  const out = ['## What we know about this item']
  if (memory.plan) out.push('', '### Plan', memory.plan.trim())
  const recent = memory.decisions.slice(-MEMORY_DECISIONS_IN_PROMPT)
  if (recent.length) {
    out.push('', '### Decisions so far')
    for (const d of recent) out.push(`- ${new Date(d.at).toISOString().slice(0, 10)} (${d.by}): ${d.text}`)
  }
  return out.join('\n')
}
