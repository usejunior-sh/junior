/**
 * Junior's first message (JuniorOnboarding) and the "Pick a default project"
 * gate share one answer: did you skip the message this browser session?
 * The message owns a zero-project workspace; the gate asks only once you
 * skip it. Per workspace, in sessionStorage, with a same-tab event so App
 * (the gate) and JuniorPage (the message) agree without a reload.
 */
import { useCallback, useEffect, useState } from 'react'
import { onboardingSkipKey } from '../../core/junior/onboarding-gate.js'

const EVENT = 'junior:onboarding-skipped'
// storage blocked: this page load only, still shared between App and JuniorPage
const memory = new Map<string, boolean>()

function readSkipped(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return memory.get(key) ?? false
  }
}

/** Skip for now on Junior's first message: per workspace, for this browser session. */
export function useOnboardingSkipped(workspaceId: string): [boolean, (v: boolean) => void] {
  const key = onboardingSkipKey(workspaceId)
  const [skipped, setSkipped] = useState(() => readSkipped(key))
  useEffect(() => {
    setSkipped(readSkipped(key))
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail === key) setSkipped(readSkipped(key))
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [key])
  const set = useCallback(
    (v: boolean) => {
      try {
        if (v) sessionStorage.setItem(key, '1')
        else sessionStorage.removeItem(key)
      } catch {
        memory.set(key, v)
      }
      setSkipped(v)
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }))
    },
    [key],
  )
  return [skipped, set]
}
