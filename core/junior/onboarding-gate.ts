/**
 * Junior's first message and the "Pick a default project" gate share one
 * answer: did you skip the message this browser session? Pure and
 * browser-safe; the hooks are in web/src/onboarding.ts.
 */

/** sessionStorage key for Skip for now on Junior's first message, per workspace. */
export function onboardingSkipKey(workspaceId: string): string {
  return `junior.onboarding.skipped.${workspaceId}`
}

/**
 * localStorage key for Not now on the gate, per workspace. The gate only
 * opens once onboarding has run, so a dismiss there is a real answer: it
 * doesn't ask again on every open.
 */
export function projectGateDismissedKey(workspaceId: string): string {
  return `junior.projectGate.dismissed.${workspaceId}`
}

/** The gate opens only for a workspace with no projects whose first message was skipped, and never after a dismiss. */
export function defaultProjectGateOpen(s: { missing: boolean; dismissed: boolean; suspended: boolean; onboardingSkipped: boolean }): boolean {
  return s.missing && s.onboardingSkipped && !s.dismissed && !s.suspended
}
