/**
 * The Claude login check, said as Junior (onboarding-verify-message). One
 * pure table from the probe's answer to the words the dialog shows, so the
 * onboarding and create doors never drift. Browser-safe; the view is
 * VerifyLine in web/src/components/workspaceAuth.tsx.
 */
import type { WorkspaceAuthBackend, WorkspaceVerifyResponse } from '../../shared/protocol.js'
import type { Mood } from './mood.js'

/** What the dialog holds: nothing yet, a probe in flight, or its answer. */
export type VerifyCopyState = WorkspaceVerifyResponse | 'probing' | null

export type VerifyCopy =
  | { kind: 'idle' }
  | { kind: 'checking'; mood: Mood; line: string; meta: string }
  | { kind: 'ok'; mood: Mood; line: string; meta: string; connectors: string }
  | {
      kind: 'error'
      mood: Mood
      line: string
      /** shown in mono: what came back, never empty */
      reason: string
      fix: string
      /** config-dir: the fix is running `loginCommand` */
      showLoginCommand: boolean
    }

/** Before any check, a config-dir login has one thing to do first. */
export const BEFORE_CONFIG_DIR = 'Run this once in a terminal first.'

const FIX: Record<WorkspaceAuthBackend, string> = {
  inherit: 'Sign in once with `claude` in a terminal, then try again.',
  'config-dir': 'Run this once in a terminal, then try again.',
  'api-key': 'Check the key above, then try again.',
}

/** "{n} models · {first 3 names}", or the empty line. */
export function modelsMeta(names: readonly string[]): string {
  if (names.length === 0) return 'No models listed yet.'
  const n = `${names.length} model${names.length === 1 ? '' : 's'}`
  return `${n} · ${names.slice(0, 3).join(' · ')}`
}

/** Report what the probe saw, never assert from the backend alone. */
export function connectorsLine(
  r: { slackConnected: boolean; connectors: readonly { source: string; status: string }[] },
  backend: WorkspaceAuthBackend,
): string {
  if (r.slackConnected) return 'I can see Slack too.'
  const live = r.connectors.filter((c) => c.source === 'claude.ai' && c.status === 'connected').length
  if (live > 0) return `I can't see Slack. ${live} other connector${live === 1 ? ' is' : 's are'} live.`
  if (backend === 'api-key') return 'No Slack with an API key. GitHub through gh still works.'
  return "I can't see any claude.ai connectors yet."
}

export function verifyCopy(state: VerifyCopyState, backend: WorkspaceAuthBackend): VerifyCopy {
  if (state === null) return { kind: 'idle' }
  if (state === 'probing')
    return { kind: 'checking', mood: 'think', line: 'Checking I can reach Claude…', meta: 'Takes a few seconds.' }
  const failed = !state.ok || !state.authOk
  if (failed) {
    const why = (state.ok ? state.authError : state.error)?.trim()
    return {
      kind: 'error',
      mood: 'stuck',
      line: "I can't reach Claude yet. Here's why.",
      reason: why || 'No reason came back.',
      fix: FIX[backend],
      showLoginCommand: backend === 'config-dir',
    }
  }
  return {
    kind: 'ok',
    mood: 'done',
    line: backend === 'api-key' ? 'I can reach Claude with your API key.' : 'I can reach Claude with your login.',
    meta: modelsMeta(state.models.map((m) => m.name)),
    connectors: connectorsLine(state, backend),
  }
}
