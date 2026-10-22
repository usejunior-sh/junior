/**
 * The capability check: what a provider lacks out of what a caller needs.
 * Pure, so it is unit-tested without spawning an agent.
 */
import type { Capability, Provider } from './types.js'

/** The capabilities in `needs` that `provider` doesn't report, in order. */
export function missingCapabilities(provider: Pick<Provider, 'capabilities'>, needs: readonly Capability[]): Capability[] {
  return needs.filter((c) => provider.capabilities[c] !== true)
}

/** Throws, naming each missing capability, unless `provider` has all of `needs`. */
export function requireCapabilities(provider: Pick<Provider, 'label' | 'capabilities'>, needs: readonly Capability[], what: string): void {
  const missing = missingCapabilities(provider, needs)
  if (missing.length) throw new Error(`${provider.label} can't ${what}: no ${missing.join(', ')}`)
}

/**
 * The tool-call veto unattended work rests on: a fence run before every tool
 * call (`hooks`, RunSpec.veto) and junior asked before a gated tool runs
 * (`toolApproval`, SessionSpec.approve). A job runs with nobody watching and
 * a team's workers write to the checkout, so neither starts on an adapter that
 * can't be stopped mid-call.
 */
export const VETO_NEEDS: readonly Capability[] = ['hooks', 'toolApproval']

/** Why `provider` may not run a job or a team, or null when it may. */
export function vetoRefusal(provider: Pick<Provider, 'label' | 'capabilities'>, what: 'job' | 'team'): string | null {
  const missing = missingCapabilities(provider, VETO_NEEDS)
  if (!missing.length) return null
  return `${provider.label} can't run a ${what}: it has no tool-call veto (no ${missing.join(', ')}), so nothing could fence its tool calls`
}

/** Throws `vetoRefusal`'s reason unless `provider` may run a job or a team. */
export function requireVeto(provider: Pick<Provider, 'label' | 'capabilities'>, what: 'job' | 'team'): void {
  const refusal = vetoRefusal(provider, what)
  if (refusal) throw new Error(refusal)
}
