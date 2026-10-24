/**
 * "Close with a note" on a Close? row (core/work/close.ts): a chat draft with
 * Junior, linked to the PR and prefilled with one line. Nothing is drafted
 * until you send it; then Junior writes the note, and the `gh pr close
 * --comment` it runs is held as a send card for your OK (core/actions/policy.ts).
 * No form: the draft asks where it runs when no project matches the repo.
 */
import type { ProjectsResponse, ScoredItem } from '../../shared/protocol.js'
import { closePrompt } from '../../core/work/close.js'
import { draftStore } from './drafts.js'
import { draftRoute } from './app/tabs.js'
import { refOf } from './itemRef.js'

export function closeWithNote(item: ScoredItem, navigate: (hash: string) => void): void {
  const c = item.close
  if (!c) return
  const ref = refOf(item)
  const open = (cwd?: string) => {
    const d = draftStore.create({ label: `Close ${ref}`, itemId: item.id, text: closePrompt(ref, c), ...(cwd ? { cwd } : {}) })
    navigate(draftRoute(d.id))
  }
  void fetch('/api/projects')
    .then((r) => r.json() as Promise<ProjectsResponse>)
    .then((p) => {
      const match = p.ok && ((item.projectId && p.projects.find((x) => x.id === item.projectId)) || (item.repo && p.projects.find((x) => x.repo && x.repo === item.repo)))
      open(match ? match.path : undefined)
    })
    .catch(() => open())
}
