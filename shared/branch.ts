/**
 * Branch names for new worktrees, from a title: `{kind}/{slug}` —
 * "Model list is cached forever" → `fix/model-list-is-cached-forever`.
 * Shared so the item dispatch (server) and the new-session composer (web)
 * name a branch the same way. Git has the last word on validity.
 */

const FIX = /\b(fix|bug|broken|break|crash|fail|fails|failing|error|wrong|regress\w*|leak|stuck|freeze\w*|cached forever)\b/i

/** fix/ for what reads as a defect, feat/ for the rest. */
export const branchKind = (title: string): 'fix' | 'feat' => (FIX.test(title) ? 'fix' : 'feat')

export function slugify(text: string, maxWords = 6, maxLen = 40): string {
  const words = text
    .toLowerCase()
    .replace(/@[\w-]+:[^\s]+/g, ' ') // `@item:…` mention tokens
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
  let slug = ''
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w
    if (next.length > maxLen) break
    slug = next
  }
  return slug || words[0]?.slice(0, maxLen) || ''
}

/** A branch for a new worktree, or '' when the title has nothing to name it by. */
export function branchFromTitle(title: string): string {
  const slug = slugify(title.split('\n')[0] ?? '')
  return slug ? `${branchKind(title)}/${slug}` : ''
}

/** Rough client-side check, so a typo is caught before git says no. */
export function plausibleBranch(name: string): boolean {
  return (
    /^[\w./-]+$/.test(name) &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.startsWith('-')
  )
}
