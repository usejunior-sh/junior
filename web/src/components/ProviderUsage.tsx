/**
 * One agent's account as it reports it: who is signed in and on what plan,
 * each plan window as a meter, credits, and what it used lately. Shared by the
 * top-bar Providers popover and Settings → Providers so the two read alike.
 */
import type { ProviderLimit, ProviderStatus } from '../../../shared/protocol.js'
import { compactTokens, planLabel, resetsIn } from '../providerStatus.js'

const KIND_LABEL: Record<string, string> = {
  chatgpt: 'ChatGPT',
  apiKey: 'API key',
  'claude.ai': 'claude.ai',
  amazonBedrock: 'Bedrock',
  bedrock: 'Bedrock',
  vertex: 'Vertex',
}

/** "samar@… · Business plan" — or what there is of it. */
export function accountLine(status: ProviderStatus): string {
  const a = status.account
  if (!a) return ''
  const parts = [a.email, a.plan ? `${planLabel(a.plan)} plan` : a.kind ? (KIND_LABEL[a.kind] ?? a.kind) : undefined, a.org]
  return parts.filter(Boolean).join(' · ')
}

/** Past this share used, a meter turns to the warning colour; past the next, the error one. */
const tone = (pct: number) => (pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : '')

export function LimitMeter({ limit }: { limit: ProviderLimit }) {
  const pct = Math.max(0, Math.min(100, Math.round(limit.usedPercent)))
  return (
    <div className={`provMeter ${tone(pct)}`}>
      <span className="lab">{limit.label}</span>
      <span className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${limit.label} used`}>
        <i style={{ width: `${pct}%` }} />
      </span>
      <span className="pct">{pct}%</span>
      <span className="reset">{limit.resetsAt ? `resets ${resetsIn(limit.resetsAt)}` : ''}</span>
    </div>
  )
}

export function ProviderUsage({ status }: { status: ProviderStatus }) {
  if (!status.ok) return <div className="provErr">{status.error ?? 'Couldn’t read this account.'}</div>
  const { recent, credits } = status
  const facts = [
    recent?.costUsd != null ? `$${recent.costUsd.toFixed(2)} list price` : null,
    recent?.tokens != null ? `${compactTokens(recent.tokens)} tokens` : null,
  ].filter(Boolean)
  return (
    <div className="provUsage">
      {status.limits.length > 0 ? (
        <div className="provMeters">
          {status.limits.map((l) => (
            <LimitMeter key={l.label} limit={l} />
          ))}
        </div>
      ) : (
        <div className="provNone">No plan limits reported for this login.</div>
      )}
      {(facts.length > 0 || credits) && (
        <div className="provFacts">
          {facts.length > 0 && (
            <span>
              Last {recent!.days} days: {facts.join(' · ')}
            </span>
          )}
          {credits && (
            <span>
              Credits: {credits.unlimited ? 'unlimited' : credits.balance ? credits.balance : credits.hasCredits ? 'available' : 'none left'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
