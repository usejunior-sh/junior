/**
 * How full a chat's context is (core/usage/context.ts), drawn two ways: a
 * hairline under a sidebar row, and a small meter above Junior's composer.
 * Neutral until 80%, then amber: compaction is near. Never orange, which
 * means "needs you". Nothing is drawn before the first turn reports usage.
 */
import { useMemo } from 'react'
import type { SessionEvent } from '../../../shared/protocol.js'
import { DM_COMPACT_WINDOW } from '../../../core/junior/dms.js'
import { CONTEXT_FULL_PCT, contextPct, contextUse, tokens } from '../usageFormat.js'
import type { ContextUse } from '../../../core/usage/context.js'
import { Tooltip } from '../ui/Tooltip.js'

/** "34% of context · 68k of 200k", and for a DM where it compacts. */
export function contextLabel(use: ContextUse, kind?: string | null): string {
  const compacts = kind === 'dm' && use.window === DM_COMPACT_WINDOW ? ', where it compacts' : ''
  return `${use.pct}% of context · ${tokens(use.used)} of ${tokens(use.window)}${compacts}`
}

/** The sidebar's hairline, from a session summary. Decorative: the row's title carries the figure. */
export function RowContextBar({ use }: { use: ContextUse | null }) {
  if (!use) return null
  return (
    <span className="ctxLine" aria-hidden="true">
      <i style={{ width: `${use.pct}%` }} className={use.pct >= CONTEXT_FULL_PCT ? 'full' : undefined} />
    </span>
  )
}

/** A summary's context, with a DM's compaction point as full. */
export const summaryContext = (s?: { kind?: string; context?: { used: number; window: number } }) => (s ? contextPct(s.context, s.kind) : null)

/** Above Junior's composer: the bar and the percentage, the tokens on hover. */
export function ContextMeter({ events, kind }: { events: readonly SessionEvent[]; kind?: string | null }) {
  const use = useMemo(() => contextUse(events, kind), [events, kind])
  if (!use) return null
  const full = use.pct >= CONTEXT_FULL_PCT
  return (
    <div className="ctxMeter">
      <Tooltip content={contextLabel(use, kind)} side="top" align="end">
        <div
          className={`ctxMeterIn${full ? ' full' : ''}`}
          role="meter"
          tabIndex={0}
          aria-label="Context used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={use.pct}
          aria-valuetext={contextLabel(use, kind)}
        >
          <span className="lab">context</span>
          <span className="ctxMeterBar" aria-hidden="true">
            <i style={{ width: `${use.pct}%` }} />
          </span>
          <span className="pct">{use.pct}%</span>
        </div>
      </Tooltip>
    </div>
  )
}
