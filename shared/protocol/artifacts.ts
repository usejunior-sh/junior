

// ---------------------------------------------------------------------------
// Artifacts (GET/POST/PUT/DELETE /api/artifacts, GET/POST/DELETE /api/links) —
// markdown files with frontmatter under the workspace's artifacts folder
// (.docs/next-version.md, phase 1). The file is the truth; this is its index
// row. There is ONE kind of artifact: what a document *is to* an item or a
// session ("the brief for", "context for") is a link role, not a type.
// ---------------------------------------------------------------------------

export type ArtifactAuthor = 'human' | 'model'
export const isArtifactAuthor = (v: unknown): v is ArtifactAuthor => v === 'human' || v === 'model'

export type Artifact = {
  id: string
  /** `/`-joined path relative to the workspace's artifacts folder */
  path: string
  title: string
  /** who wrote it: the model rewrites its own files in place; yours it may only propose to */
  author: ArtifactAuthor
  /** canonical refs (github:owner/repo#1, linear:KEY-1) the frontmatter declares */
  refs: string[]
  created: number
  updated: number
  /** file mtime and size at index time — the cheap "has it changed" check */
  mtime: number
  size: number
  /** set when the frontmatter did not parse and defaults were used */
  warning?: string
}

export type LinkKind = 'artifact' | 'item' | 'session'
export const LINK_KINDS: readonly LinkKind[] = ['artifact', 'item', 'session']
export const isLinkKind = (v: unknown): v is LinkKind => LINK_KINDS.includes(v as LinkKind)

/**
 * artifact→item: `brief` (the document about it — inherits the item's
 * lifecycle) or `context` (human notes it should be read with);
 * artifact→session: `context`; session→item: `dispatch` (the session works
 * the item) or `brief` (the session wrote its brief).
 */
export type LinkRole = 'brief' | 'report' | 'context' | 'dispatch' | 'plan'
export const LINK_ROLES: readonly LinkRole[] = ['brief', 'report', 'context', 'dispatch', 'plan']
export const isLinkRole = (v: unknown): v is LinkRole => LINK_ROLES.includes(v as LinkRole)

export type Link = {
  id: string
  fromKind: LinkKind
  fromId: string
  toKind: LinkKind
  toId: string
  role: LinkRole
  createdAt: number
}

/** POST /api/artifacts body (create) and PUT /api/artifacts?id= body (patch). */
export type ArtifactInput = {
  title?: string
  body?: string
  refs?: string[]
  /** create only; defaults to human. The stdio shim and sessions write as model. */
  author?: ArtifactAuthor
  /** create only: links to add right away */
  links?: { kind: LinkKind; id: string; role: LinkRole }[]
}

/** An index row with its outgoing links, and whether the list hides it by default. */
export type ArtifactWithLinks = Artifact & {
  links: Link[]
  /** linked as the brief of an item that is done or archived */
  hidden: boolean
}

export type ArtifactsResponse =
  | { ok: true; root: string; artifacts: ArtifactWithLinks[] }
  | { ok: false; error: string }

export type ArtifactContentResponse =
  | { ok: true; artifact: Artifact; body: string; links: Link[]; abs: string }
  | { ok: false; error: string }

export type ArtifactResponse = { ok: true; artifact: Artifact } | { ok: false; error: string }

export type LinksResponse = { ok: true; links: Link[] } | { ok: false; error: string }
