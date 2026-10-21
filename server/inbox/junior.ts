/**
 * The inbox snapshot's Junior side (hand-offs, Phase 1): on each ranked item,
 * where it stands with Junior (core/work/handoff.ts), what Junior could take
 * on it (core/junior/suggest.ts), and the babysit watch's read of your PR.
 * Reads config only: the rules, and the watch's last poll.
 */
import { suggestionFor } from '../../core/junior/suggest.js'
import { ruleFor, RULES_KEY, rulesConfigFrom, rulesOf } from '../../core/rules/rules.js'
import { handedOff, juniorWork, openedPr } from '../../core/work/handoff.js'
import type { ItemTask } from '../../core/work/tasks.js'
import type { ScoredItem } from '../../core/work/types.js'
import { BABYSIT_WATCH_KEY, type BabysitWatchState } from '../babysit/watch.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'

export async function withJunior(rt: WorkspaceRuntime, ranked: ScoredItem[], tasks: ReadonlyMap<string, ItemTask[]>): Promise<void> {
  const [rules, watch] = await Promise.all([
    rt.store.config.get(RULES_KEY).then((raw) => rulesOf(rulesConfigFrom(raw))),
    rt.store.config.get<BabysitWatchState>(BABYSIT_WATCH_KEY),
  ])
  const byId = new Map(ranked.map((i) => [i.id, i]))
  // the draft PRs Junior opened, by the item it opened them from
  const opened = new Map<string, string>()
  for (const i of ranked) {
    const pr = openedPr(tasks.get(i.id) ?? [])
    if (pr) opened.set(pr, i.id)
  }
  for (const i of ranked) {
    const ts = tasks.get(i.id) ?? []
    const seen = watch?.prs[i.id]?.seen
    if (seen) i.seen = seen
    const isPr = i.reason === 'your-pr' || i.reason === 'review-requested'
    const pr = openedPr(ts)
    const work = juniorWork(i.handoff, ts, isPr, pr ? byId.get(pr)?.handoff === 'on' : false)
    if (work) i.junior = work
    const rule = ruleFor({ reason: i.reason, ...(i.label ? { label: i.label } : {}) }, rules)
    const s = suggestionFor({
      item: i,
      juniorBusy: handedOff(undefined, ts),
      reviewed: ts.some((t) => t.step === 'review'),
      ...(seen ? { seen } : {}),
      juniorPr: opened.has(i.id),
      rule: rule ? { playbook: rule.playbook, start: rule.start } : null,
    })
    if (s) i.suggestion = s
  }
}
