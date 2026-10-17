/**
 * "Right now": where Junior is, in one line above the headline. The most
 * relevant live session wins, one on today's plan first, then the most
 * recently active, and its own todo list says what it is doing and which
 * step it's on. Pure and browser-safe.
 */

/** Progress read off a session's latest todo list (Claude Code's TodoWrite). */
export type TodoProgress = { activity: string; n: number; of: number }

/** The event shape this reads: a persisted `sdk` session event, loosely typed. */
type EventLike = { kind: string; message?: { type?: string; parent_tool_use_id?: string | null; message?: { content?: unknown } } }

type Todo = { content?: unknown; status?: unknown; activeForm?: unknown }

/** "Finding the flake" → "finding the flake"; "PR #12 review" stays as it is. */
export const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s)

/**
 * The main agent's latest todo list, as progress: the step in progress (its
 * present-tense form), else the first one not started. Null when there is no
 * list, or everything on it is done.
 */
export function todoProgress(events: readonly unknown[]): TodoProgress | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = (events[i] ?? {}) as EventLike
    if (ev.kind !== 'sdk' || ev.message?.type !== 'assistant' || ev.message.parent_tool_use_id) continue
    const content = ev.message.message?.content
    if (!Array.isArray(content)) continue
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j] as { type?: string; name?: string; input?: { todos?: unknown } }
      if (b?.type !== 'tool_use' || b.name !== 'TodoWrite' || !Array.isArray(b.input?.todos)) continue
      const todos = b.input.todos as Todo[]
      if (!todos.length) return null
      const text = (t: Todo) => String((typeof t.activeForm === 'string' && t.activeForm) || (typeof t.content === 'string' && t.content) || '').trim()
      let at = todos.findIndex((t) => t.status === 'in_progress')
      if (at === -1) at = todos.findIndex((t) => t.status !== 'completed')
      if (at === -1) return null
      const activity = text(todos[at])
      return activity ? { activity: lowerFirst(activity), n: at + 1, of: todos.length } : null
    }
  }
  return null
}

/** Something running that the line could be about. */
export type NowCandidate = {
  /** what clicking opens */
  target: { kind: 'session'; id: string } | { kind: 'job'; id: string }
  title: string
  updatedAt: number
  /** its item is on today's plan */
  onPlan: boolean
  todo: TodoProgress | null
  /** a team run's place: step n of m */
  team: { n: number; of: number } | null
}

export type NowLine =
  | { idle: true }
  | { idle: false; label: string; step: { n: number; of: number } | null; more: number; target: NowCandidate['target'] }

/** The line: the best candidate, or free. */
export function pickNow(running: readonly NowCandidate[]): NowLine {
  if (!running.length) return { idle: true }
  const best = [...running].sort((a, b) => Number(b.onPlan) - Number(a.onPlan) || b.updatedAt - a.updatedAt)[0]
  const label = best.todo?.activity ?? lowerFirst(best.title.trim() || 'working')
  const step = best.todo ? { n: best.todo.n, of: best.todo.of } : best.team
  return { idle: false, label, step, more: running.length - 1, target: best.target }
}
