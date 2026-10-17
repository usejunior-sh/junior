/**
 * Where an action landed, read from what its tool call returned: the PR URL
 * `gh pr create` prints, the issue URL in a connector's JSON, the branch a
 * `git push` updated. The first URL in the text is the fallback. Pure.
 */

/** A tool_result's content as text: a string, or the text of its blocks. */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}`\\]+/g
/** A GitHub PR, issue, comment, review or release, what `gh` prints when it made one. */
const GITHUB_THING_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/(?:pull|issues|releases\/tag)\/[^\s"'<>)]+/g
/** JSON keys a connector puts its object's address under, most specific first. */
const LINK_KEYS = ['permalink', 'html_url', 'htmlUrl', 'web_url', 'webUrl', 'url', 'link', 'href']

const trimUrl = (u: string): string => u.replace(/[.,;:!?]+$/, '')

/** The first link-ish value in parsed JSON, by key preference, breadth-first. */
function jsonLink(v: unknown): string | null {
  const queue: unknown[] = [v]
  for (let n = 0; queue.length && n < 200; n++) {
    const cur = queue.shift()
    if (!cur || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      queue.push(...cur.slice(0, 20))
      continue
    }
    const o = cur as Record<string, unknown>
    for (const k of LINK_KEYS) {
      const x = o[k]
      if (typeof x === 'string' && /^https?:\/\//.test(x)) return x
    }
    queue.push(...Object.values(o))
  }
  return null
}

/** The address of a GitHub remote (`To github.com:o/r.git`, `https://github.com/o/r`), as `o/r`. */
function githubRepo(text: string): string | null {
  const m = /^To\s+(?:https?:\/\/|ssh:\/\/)?(?:[^@\s]+@)?github\.com[:/]([^/\s]+)\/([^\s]+?)(?:\.git)?\/?\s*$/m.exec(text)
  return m ? `${m[1]}/${m[2]}` : null
}

/**
 * The branch a `git push` updated, from git's own report (`   a1..b2  feat -> feat`,
 * ` * [new branch]      feat -> feat`). Null for "Everything up-to-date".
 */
export function pushedBranch(text: string): string | null {
  const m = /^\s*[ +*!=-]?\s*(?:\[[^\]]+\]|[0-9a-f]{4,}\.\.\.?[0-9a-f]{4,})\s+\S+\s+->\s+(\S+)/m.exec(text)
  return m ? m[1].replace(/^refs\/heads\//, '') : null
}

/** A push's "open a PR" hint (`remote: https://github.com/o/r/pull/new/feat`), the one remote: URL worth keeping. */
const PULL_NEW_RE = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/new\/\S+/

/**
 * Where an action landed.
 * - push: the branch on GitHub, else the remote's "open a PR" link, else
 *   nothing, the other `remote:` lines are the server's chatter (a
 *   dependabot notice), not where the push went.
 * - JSON (a connector's response): its own url-like field, and nothing else,
 *   a description quoting some PR is not where the ticket is.
 * - `bash` output (gh): the PR / issue / comment URL it printed.
 * - anything else: a quoted url field, then the first URL in the text.
 */
export function extractLink(text: string, opts: { push?: boolean; bash?: boolean } = {}): string | null {
  if (!text) return null
  if (opts.push) {
    const repo = githubRepo(text)
    const branch = pushedBranch(text)
    if (repo && branch) return `https://github.com/${repo}/tree/${branch}`
    const pr = PULL_NEW_RE.exec(text)
    return pr ? trimUrl(pr[0]) : null
  }
  const t = text.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return jsonLink(JSON.parse(t))
    } catch {}
  }
  if (opts.bash) {
    const gh = text.match(GITHUB_THING_RE)
    if (gh?.length) return trimUrl(gh[gh.length - 1])
  }
  const keyed = /"(?:permalink|html_url|htmlUrl|web_url|webUrl|url|link)"\s*:\s*"(https?:\/\/[^"]+)"/.exec(text)
  if (keyed) return keyed[1]
  const first = text.match(URL_RE)
  return first?.length ? trimUrl(first[0]) : null
}
