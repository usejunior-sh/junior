/**
 * Rules, wired to a workspace (core/rules): the stored config, the rules as
 * they stand, and the two ways a playbook starts on an item: a rule, when a
 * job files it, or you, from the item's offer ("Start debug-fix?").
 */
import { randomUUID } from 'node:crypto'
import {
  isRuleStart,
  PLAYBOOK_NAME,
  PLAYBOOK_START,
  ruleFor,
  ruleFrom,
  ruleLine,
  RULES_KEY,
  rulesConfigFrom,
  rulesOf,
  STARTABLE,
  startFor,
  whenLine,
  withRule,
  type Rule,
  type RulesConfig,
  type Tier,
} from '../core/rules/rules.js'
import { isPlaybook, reasonOf, type Playbook } from '../core/work/fields.js'
import type { ItemTask, TaskWhy } from '../core/work/tasks.js'
import type { WorkItem } from '../core/work/types.js'
import { babysitSettings } from './babysit/glue.js'
import { errText } from './errors.js'
import { log } from './log.js'
import { pumpTasks, tasksChanged } from './tasks/runner.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

export async function rulesConfig(rt: WorkspaceRuntime): Promise<RulesConfig> {
  return rulesConfigFrom(await rt.store.config.get(RULES_KEY))
}

/** Every rule as it stands, the watch rows following Settings → Babysit. */
export async function currentRules(rt: WorkspaceRuntime): Promise<Rule[]> {
  const [cfg, s] = await Promise.all([rulesConfig(rt), babysitSettings(rt)])
  return rulesOf(cfg, { babysit: s.enabled, reviews: s.reviews })
}

async function saveRules(rt: WorkspaceRuntime, cfg: RulesConfig): Promise<Rule[]> {
  await rt.store.config.set(RULES_KEY, cfg)
  // an item's offer follows its rule: the inbox redraws
  tasksChanged(rt)
  return currentRules(rt)
}

/**
 * A job filed (or re-filed) an item: if its rule starts a playbook alone, and
 * the job's tier lets it, the playbook's first task is added. Otherwise the
 * item page offers it. Never throws: filing an item never fails on a rule.
 */
export async function applyRules(rt: WorkspaceRuntime, itemId: string, tier: Tier): Promise<void> {
  try {
    const item = await rt.store.items.get(itemId)
    if (!item) return
    const rule = ruleFor({ reason: reasonOf(item), ...(item.label ? { label: item.label } : {}) }, await currentRules(rt))
    if (!rule?.playbook || !STARTABLE.includes(rule.playbook) || startFor(rule, tier) !== 'auto') return
    // the same activity never starts it twice; new activity on the thread may
    await startPlaybook(rt, item, rule.playbook, 'playbook', `rule: ${whenLine(rule)}`, `rule@${item.updatedAt}`)
  } catch (err) {
    log('warn', 'rules', `could not apply the rules to ${itemId}: ${errText(err)}`, { workspace: rt.meta.id })
  }
}

/** You started a playbook from the item page (its offer, or by hand). */
export async function startPlaybookOp(rt: WorkspaceRuntime, raw: unknown): Promise<ItemTask> {
  const r = (raw ?? {}) as Record<string, unknown>
  const itemId = typeof r.itemId === 'string' ? r.itemId : ''
  const item = itemId ? await rt.store.items.get(itemId) : null
  if (!item) throw new Error('no such item')
  if (!isPlaybook(r.playbook) || !STARTABLE.includes(r.playbook)) throw new Error(`Junior can start ${STARTABLE.join(', ')} on an item`)
  const busy = (await rt.store.tasks.list(item.id)).find((t) => t.state === 'queued' || t.state === 'running')
  if (busy) throw new Error(`"${busy.title}" is already on its way`)
  const t = await startPlaybook(rt, item, r.playbook, 'you', `you started ${PLAYBOOK_NAME[r.playbook]}`, `you@${Date.now()}`)
  if (!t) throw new Error('could not add the task')
  return t
}

async function startPlaybook(rt: WorkspaceRuntime, item: WorkItem, playbook: Playbook, why: TaskWhy, whyDetail: string, key: string): Promise<ItemTask | null> {
  const start = PLAYBOOK_START[playbook]
  if (!start) return null
  const t = await rt.store.tasks.add(
    { itemId: item.id, title: start.title, owner: 'junior', why, whyDetail, step: start.step, key: `${start.step}:${key}` },
    Date.now(),
  )
  if (!t) return null
  if (item.playbook !== playbook) await rt.store.items.setFields(item.id, { playbook })
  log('info', 'rules', `${why === 'you' ? 'you started' : 'started'} ${PLAYBOOK_NAME[playbook]} on ${item.id}`, { task: t.id, workspace: rt.meta.id })
  tasksChanged(rt)
  void pumpTasks(rt)
  return t
}

// Settings → Rules, and the Rule card in chat.

/** Switch a built-in on or off, or between starting alone and offering. */
export async function setBuiltinRuleOp(rt: WorkspaceRuntime, raw: unknown): Promise<Rule[]> {
  const r = (raw ?? {}) as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  const cfg = await rulesConfig(rt)
  const rule = (await currentRules(rt)).find((x) => x.id === id)
  if (!rule?.builtin) throw new Error('no such built-in rule')
  if (rule.watch) throw new Error('this rule is switched in Settings → Babysit')
  const prev = cfg.builtins[id] ?? {}
  const next = {
    ...prev,
    ...(typeof r.on === 'boolean' ? { on: r.on } : {}),
    ...(isRuleStart(r.start) ? { start: r.start } : {}),
  }
  log('info', 'rules', `built-in ${id}: ${JSON.stringify(next)}`, { workspace: rt.meta.id })
  return saveRules(rt, { ...cfg, builtins: { ...cfg.builtins, [id]: next } })
}

/** Add one of your rules (the Rule card's Add): one per reason + label, a second replaces the first. */
export async function addRuleOp(rt: WorkspaceRuntime, raw: unknown): Promise<Rule[]> {
  const r = (raw ?? {}) as Record<string, unknown>
  const by = r.by === 'junior' ? 'junior' : 'you'
  const rule = ruleFrom({ ...r, id: randomUUID().slice(0, 8), on: true, by, createdAt: Date.now() })
  if (!rule) throw new Error('a rule needs a reason, an optional label, a playbook (answer, debug-fix, investigate, or null) and auto or suggest')
  let cfg = withRule(await rulesConfig(rt), rule)
  // took a proposal: it is no longer one
  if (typeof r.proposal === 'string' && !cfg.neverAsk.includes(r.proposal)) cfg = { ...cfg, neverAsk: [...cfg.neverAsk, r.proposal] }
  log('info', 'rules', `added: ${ruleLine(rule)}`, { workspace: rt.meta.id })
  return saveRules(rt, cfg)
}

export async function removeRuleOp(rt: WorkspaceRuntime, raw: unknown): Promise<Rule[]> {
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : ''
  const cfg = await rulesConfig(rt)
  if (!cfg.mine.some((r) => r.id === id)) throw new Error('no such rule of yours')
  return saveRules(rt, { ...cfg, mine: cfg.mine.filter((r) => r.id !== id) })
}

/** "Never ask" on a proposal: Junior doesn't raise it again. */
export async function neverAskOp(rt: WorkspaceRuntime, raw: unknown): Promise<Rule[]> {
  const key = typeof (raw as { proposal?: unknown })?.proposal === 'string' ? (raw as { proposal: string }).proposal : ''
  if (!key) throw new Error('proposal required')
  const cfg = await rulesConfig(rt)
  if (cfg.neverAsk.includes(key)) return currentRules(rt)
  return saveRules(rt, { ...cfg, neverAsk: [...cfg.neverAsk, key] })
}
