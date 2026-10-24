/**
 * Junior's first message and the "Pick a default project" gate share one
 * answer: did you skip the message this browser session? Pure and
 * browser-safe; the hook is web/src/onboarding.ts.
 */

/** sessionStorage key for Skip for now on Junior's first message, per workspace. */
export function onboardingSkipKey(workspaceId: string): string {
  return `junior.onboarding.skipped.${workspaceId}`
}

/** The gate opens only for a workspace with no projects whose first message was skipped. */
export function defaultProjectGateOpen(s: { missing: boolean; later: boolean; suspended: boolean; onboardingSkipped: boolean }): boolean {
  return s.missing && s.onboardingSkipped && !s.later && !s.suspended
}
