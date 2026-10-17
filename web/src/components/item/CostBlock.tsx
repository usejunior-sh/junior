import type { SessionsUsage } from '../../../../shared/protocol.js'
import { money, tokens, modelLabel } from '../../usageFormat.js'
import type { CostSplit, LinkedSession } from './types.js'

export function CostBlock({ linkedSessions, spend, spendFailed, split }: { linkedSessions: LinkedSession[]; spend: SessionsUsage | null; spendFailed: boolean; split: CostSplit[] }) {
  return (
    <>
      {/* What the item cost: the ledger, folded over this item's sessions.
          Deliberately small: the cache share, the daily series and the
          per-project view stay on Usage. Placements considered:
          .docs/item-cost-variations.html */}
      {linkedSessions.length > 0 && !spendFailed && (
        <div className="costBlock">
          <div className="head">
            <span className="lab">Cost</span>
            <span className="win">last {spend?.days ?? 30}d</span>
          </div>
          {spend ? (
            <>
              <div className="big" title="Priced at API list prices — on a Pro or Max plan nothing is billed per token">
                {money(spend.totals.cost)}
                {!spend.totals.priced && <span className="approx">+</span>}
              </div>
              <div className="sub">
                {tokens(spend.totals.tokens)} tokens · {spend.totals.sessions}
                {spend.totals.sessions === 1 ? ' session' : ' sessions'}
              </div>
              {/* A single-model item gets no meter: one full bar says nothing.
                  The legend below always names the models and carries their
                  values, so identity is never colour alone. */}
              {split.length > 1 && (
                <div
                  className="meter"
                  role="img"
                  aria-label={`Spend by model: ${split.map((m) => `${modelLabel(m.model)} ${money(m.cost)}`).join(', ')}`}
                >
                  {split.map((m) => (
                    <span
                      key={m.model}
                      style={{ width: `${(m.cost / spend.totals.cost) * 100}%`, background: m.color }}
                      title={`${modelLabel(m.model)} · ${money(m.cost)} · ${tokens(m.tokens)} tokens`}
                    />
                  ))}
                </div>
              )}
              {split.length > 0 && (
                <div className="keys">
                  {split.map((m) => (
                    <span className="key" key={m.model}>
                      <i className="sw" style={{ background: m.color }} aria-hidden="true" />
                      {modelLabel(m.model)} <span className="v">{money(m.cost)}</span>
                    </span>
                  ))}
                </div>
              )}
              <div className="foot">
                list-price equivalent{!spend.totals.priced && ' · some tokens unpriced'}
              </div>
            </>
          ) : (
            <div className="asideEmpty">Reading transcripts…</div>
          )}
        </div>
      )}
    </>
  )
}
