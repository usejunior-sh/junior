/**
 * Rules (Junior for engineers, M4): jobs bring work in, rules decide what
 * Junior does with it. A rule is "when an item is here for this reason and is
 * this label, work it with this playbook", started alone (auto) or offered to
 * you (suggest). Plan artifact cb50520f, "Rules".
 *
 * The built-in rules ship on, and only ever suggest (hand-offs, Phase 1,
 * artifact f335b876): nothing starts until you hand it off. You turn them off,
 * and add your own (in chat, from a Rule card); a rule you added may start
 * alone. Junior proposes new ones from its track record (./proposals.ts).
 *
 * Your PRs and review requests are worked by their own watches (core/babysit,
 * core/review), only once you hand the PR off; their rows here only say so.
 *
 * Pure and browser-safe.
 */
import { isItemLabel, isPlaybook, isReason, type ItemLabel, type Playbook, type Reason } from '../work/fields.js'

export type RuleStart = 'auto' | 'suggest'
export const isRuleStart = (v: unknown): v is RuleStart => v === 'auto' || v === 'suggest'

export type Rule = {
  id: string
  when: { reason: Reason; label?: ItemLabel }
  /** null = nothing to do: the item is for you to read (FYI) */
  playbook: Playbook | null
  start: RuleStart
  on: boolean
  /** junior shipped it; you can switch it, not delete it */
  builtin: boolean
  /** worked by a watch on the PRs you hand off: listed, not edited here */
  watch?: boolean
  /** who added it: you, or Junior's proposal you took */
  by?: 'you' | 'junior'
  createdAt?: number
}

/** The built-in table (cb50520f "Rules"), on by default, all suggest. Epics (plan) come later. */
export const BUILTIN_RULES: readonly Rule[] = [
  { id: 'your-pr', when: { reason: 'your-pr' }, playbook: 'babysit', start: 'suggest', on: true, builtin: true, watch: true },
  { id: 'review-requested', when: { reason: 'review-requested' }, playbook: 'review', start: 'suggest', on: true, builtin: true, watch: true },
  { id: 'asked-question', when: { reason: 'asked', label: 'question' }, playbook: 'answer', start: 'suggest', on: true, builtin: true },
  { id: 'asked-bug', when: { reason: 'asked', label: 'bug' }, playbook: 'debug-fix', start: 'suggest', on: true, builtin: true },
  { id: 'assigned-bug', when: { reason: 'assigned', label: 'bug' }, playbook: 'debug-fix', start: 'suggest', on: true, builtin: true },
  { id: 'found-bug', when: { reason: 'found', label: 'bug' }, playbook: 'debug-fix', start: 'suggest', on: true, builtin: true },
  { id: 'assigned-improvement', when: { reason: 'assigned', label: 'improvement' }, playbook: 'investigate', start: 'suggest', on: true, builtin: true },
  { id: 'mentioned', when: { reason: 'mentioned' }, playbook: null, start: 'suggest', on: true, builtin: true },
]

export const RULES_KEY = 'rules'

/** What config holds: your switches on the built-ins, your own rules, and the proposals you said never to. */
export type RulesConfig = {
  version: 1
  /** a built-in's on/off; a `start` stored before hand-offs is dropped on read: built-ins only suggest */
  builtins: Record<string, { on?: boolean }>
  mine: Rule[]
  /** proposal keys (./proposals.ts) Junior must not raise again */
  neverAsk: string[]
}

export const EMPTY_RULES: RulesConfig = { version: 1, builtins: {}, mine: [], neverAsk: [] }

type J = Record<string, unknown>
const obj = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})

/** One of your rules, as stored or posted; null when it isn't one. */
export function ruleFrom(raw: unknown): Rule | null {
  const r = obj(raw)
  const when = obj(r.when)
  if (typeof r.id !== 'string' || !/^[\w-]{1,64}$/.test(r.id)) return null
  if (!isReason(when.reason)) return null
  if (when.label !== undefined && !isItemLabel(when.label)) return null
  if (r.playbook !== null && !isPlaybook(r.playbook)) return null
  // babysit and review run off their watches, on PRs only: no rule starts them
  if (r.playbook === 'babysit' || r.playbook === 'review') return null
  if (!isRuleStart(r.start)) return null
  return {
    id: r.id,
    when: { reason: when.reason, ...(when.label ? { label: when.label as ItemLabel } : {}) },
    playbook: r.playbook as Playbook | null,
    start: r.start,
    on: r.on !== false,
    builtin: false,
    ...(r.by === 'you' || r.by === 'junior' ? { by: r.by } : {}),
    ...(typeof r.createdAt === 'number' ? { createdAt: r.createdAt } : {}),
  }
}

/** Stored config → valid config; anything off is dropped, never repaired. */
export function rulesConfigFrom(raw: unknown): RulesConfig {
  const r = obj(raw)
  const builtins: RulesConfig['builtins'] = {}
  for (const [id, v] of Object.entries(obj(r.builtins))) {
    if (!BUILTIN_RULES.some((b) => b.id === id && !b.watch)) continue
    const o = obj(v)
    if (typeof o.on === 'boolean') builtins[id] = { on: o.on }
  }
  const mine = (Array.isArray(r.mine) ? r.mine : []).map(ruleFrom).filter((x): x is Rule => x !== null)
  const neverAsk = (Array.isArray(r.neverAsk) ? r.neverAsk : []).filter((x): x is string => typeof x === 'string')
  return { version: 1, builtins, mine, neverAsk }
}

/** Every rule as it stands: the built-ins with your switches, then yours. The watch rows are always on. */
export function rulesOf(cfg: RulesConfig): Rule[] {
  const builtins = BUILTIN_RULES.map((b) => (b.watch ? b : { ...b, on: cfg.builtins[b.id]?.on ?? b.on }))
  return [...builtins, ...cfg.mine]
}

/**
 * The rule for an item: an on rule whose reason matches and whose label, if
 * it names one, matches too. A rule naming the label beats one that doesn't;
 * among equals, yours beat the built-ins (you added it later, on purpose).
 */
export function ruleFor(item: { reason: Reason; label?: ItemLabel }, rules: readonly Rule[]): Rule | null {
  let best: Rule | null = null
  let bestScore = -1
  for (const r of rules) {
    if (!r.on || r.when.reason !== item.reason) continue
    if (r.when.label && r.when.label !== item.label) continue
    const score = (r.when.label ? 2 : 0) + (r.builtin ? 0 : 1)
    if (score > bestScore) {
      best = r
      bestScore = score
    }
  }
  return best
}

/**
 * How a job's tier bends the rule: "only show" never starts anything alone,
 * so an auto rule there becomes an offer. "Start alone" leaves the rule as is.
 */
export type Tier = 'start' | 'show'
export const isTier = (v: unknown): v is Tier => v === 'start' || v === 'show'
export function startFor(rule: Rule, tier: Tier = 'start'): RuleStart {
  return tier === 'show' ? 'suggest' : rule.start
}

/** The first task a playbook adds on an item. Babysit and review add theirs from their watches. */
export type PlaybookStart = { step: string; title: string }
export const PLAYBOOK_START: Partial<Record<Playbook, PlaybookStart>> = {
  answer: { step: 'answer', title: 'Draft a reply' },
  'debug-fix': { step: 'debug-plan', title: 'Plan the fix' },
  investigate: { step: 'investigate', title: 'Investigate options' },
}

/** Playbooks a rule or you can start on any item. */
export const STARTABLE: readonly Playbook[] = ['answer', 'debug-fix', 'investigate']

/** The steps each startable playbook runs, so "already started" can be read off an item's tasks. */
export const PLAYBOOK_STEPS: Partial<Record<Playbook, readonly string[]>> = {
  answer: ['answer', 'send-reply'],
  'debug-fix': ['debug-plan', 'approve-plan', 'debug-fix'],
  investigate: ['investigate', 'decide'],
}

/** The playbook a task step belongs to. */
export function playbookOfStep(step: string | undefined): Playbook | null {
  if (!step) return null
  for (const [p, steps] of Object.entries(PLAYBOOK_STEPS)) if (steps!.includes(step)) return p as Playbook
  return null
}

export const PLAYBOOK_NAME: Record<Playbook, string> = {
  babysit: 'babysit',
  review: 'review first pass',
  answer: 'answer',
  'debug-fix': 'debug-fix',
  investigate: 'investigate',
  plan: 'plan',
}

const REASON_WORDS: Record<Reason, string> = {
  'your-pr': 'your PR',
  'review-requested': 'review requested',
  asked: 'asked',
  assigned: 'assigned',
  mentioned: 'mentioned',
  'you-added': 'you added',
  found: 'found by a job',
}

/** "asked + bug" */
export function whenLine(r: Pick<Rule, 'when'>): string {
  return `${REASON_WORDS[r.when.reason]}${r.when.label ? ` + ${r.when.label}` : ''}`
}

/** "asked + bug → debug-fix, suggest" */
export function ruleLine(r: Pick<Rule, 'when' | 'playbook' | 'start'>): string {
  if (!r.playbook) return `${whenLine(r)} → none (FYI)`
  return `${whenLine(r)} → ${PLAYBOOK_NAME[r.playbook]}, ${r.start === 'auto' ? 'starts alone' : 'offered to you'}`
}

/** Add or replace one of your rules (same when → replaced: one rule per reason + label). */
export function withRule(cfg: RulesConfig, rule: Rule): RulesConfig {
  const same = (r: Rule) => r.when.reason === rule.when.reason && (r.when.label ?? null) === (rule.when.label ?? null)
  return { ...cfg, mine: [...cfg.mine.filter((r) => r.id !== rule.id && !same(r)), rule] }
}

/**
 * What to offer you on an item ("Start debug-fix?"): the playbook its rule
 * names, when Junior can start it and nothing of it is on the item yet.
 * An auto rule whose task never came (filed under "only show", or before the
 * rule) is offered too.
 */
export function offerFor(
  item: { reason: Reason; label?: ItemLabel },
  rules: readonly Rule[],
  steps: readonly (string | undefined)[],
): { playbook: Playbook; ruleId: string } | null {
  const rule = ruleFor(item, rules)
  if (!rule?.playbook || !STARTABLE.includes(rule.playbook)) return null
  const mine = PLAYBOOK_STEPS[rule.playbook] ?? []
  if (steps.some((s) => s && mine.includes(s))) return null
  return { playbook: rule.playbook, ruleId: rule.id }
}
