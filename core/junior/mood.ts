/**
 * Junior's face says what state it is in (.docs/junior-goals-teams/README.md:
 * "expressions are states, not decoration"). Pure and browser-safe.
 */

export type Mood = 'hello' | 'listen' | 'think' | 'working' | 'needs' | 'done' | 'stuck' | 'asleep'
export const MOODS: readonly Mood[] = ['hello', 'listen', 'think', 'working', 'needs', 'done', 'stuck', 'asleep']

export const MOOD_LABEL: Record<Mood, string> = {
  hello: 'Hello',
  listen: 'Listening',
  think: 'Thinking',
  working: 'Working',
  needs: 'Needs you',
  done: 'Done',
  stuck: 'Stuck',
  asleep: 'Asleep',
}

export type MoodSignals = {
  /** rows under Needs you: blocked sessions, sends waiting on you, plans to review */
  needs: number
  /** something broke: a failed job, a paused team, a session that errored */
  stuck: boolean
  /** a Junior session or a job run is running */
  working: boolean
}

/**
 * The rail's face: the most urgent state wins, needs > stuck > working >
 * hello. It only changes when one of these does, so it never pulls the eye.
 */
export function railMood(s: MoodSignals): Mood {
  if (s.needs > 0) return 'needs'
  if (s.stuck) return 'stuck'
  if (s.working) return 'working'
  return 'hello'
}

/**
 * The page's face: the rail's, except that a first open says hello and a day
 * whose plan is all done, with nothing else going on, looks done.
 */
export function pageMood(s: MoodSignals & { firstOpen: boolean; planDone: number; planTotal: number }): Mood {
  if (s.firstOpen) return 'hello'
  const m = railMood(s)
  if (m === 'hello' && s.planTotal > 0 && s.planDone === s.planTotal) return 'done'
  return m
}
