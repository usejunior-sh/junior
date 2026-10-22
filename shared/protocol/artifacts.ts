

// Artifacts (GET/POST/PUT/DELETE /api/artifacts, GET/POST/DELETE /api/links):
// files under the workspace's artifacts folder: markdown with frontmatter, or
// any other format with a sidecar that carries its identity. The file is the
// truth; this is its index row. There is ONE kind of artifact: what a document *is to* an item or a
// session ("the brief for", "context for") is a link role, not a type.

export type ArtifactAuthor = 'human' | 'model'
export const isArtifactAuthor = (v: unknown): v is ArtifactAuthor => v === 'human' || v === 'model'

// Formats. A session publishes any of these; text ones can ride inline as a
// `body`, the rest come from a file on disk (`from`).

export type ArtifactFormat = 'md' | 'html' | 'csv' | 'txt' | 'json' | 'svg' | 'pdf' | 'png' | 'jpg' | 'gif' | 'webp'
export const ARTIFACT_FORMATS: readonly ArtifactFormat[] = ['md', 'html', 'csv', 'txt', 'json', 'svg', 'pdf', 'png', 'jpg', 'gif', 'webp']
export const isArtifactFormat = (v: unknown): v is ArtifactFormat => ARTIFACT_FORMATS.includes(v as ArtifactFormat)

/** formats a session may send inline as `body` */
export const TEXT_FORMATS: readonly ArtifactFormat[] = ['md', 'html', 'csv', 'txt', 'json', 'svg']
export const isTextFormat = (f: ArtifactFormat): boolean => TEXT_FORMATS.includes(f)
export const isImageFormat = (f: ArtifactFormat): boolean => f === 'png' || f === 'jpg' || f === 'gif' || f === 'webp' || f === 'svg'

const MIME: Record<ArtifactFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
export const formatMime = (f: ArtifactFormat): string => MIME[f]
export const formatExt = (f: ArtifactFormat): string => f

const EXT_ALIAS: Record<string, ArtifactFormat> = { htm: 'html', jpeg: 'jpg', markdown: 'md' }
/** `.HTML`, `html`, `jpeg` → the format, or null for an extension junior does not publish. */
export function formatOfExt(ext: string): ArtifactFormat | null {
  const e = ext.replace(/^\./, '').toLowerCase()
  if (isArtifactFormat(e)) return e
  return EXT_ALIAS[e] ?? null
}

/** Over this a file is refused. */
export const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024
/** Over this a file is stored without history (a git blob per version would grow the repo too fast). */
export const ARTIFACT_HISTORY_MAX_BYTES = 10 * 1024 * 1024
/** Inline `body` cap, in characters; bigger content goes through `from`. */
export const ARTIFACT_BODY_MAX_CHARS = 2_000_000
/** A non-markdown file's identity lives in `<file>.artifact.json` beside it. */
export const ARTIFACT_SIDECAR_SUFFIX = '.artifact.json'
/** The in-process write tools, by leaf name (their full names are `mcp__junior__<leaf>`). */
export const ARTIFACT_TOOLS = ['write_artifact', 'update_artifact'] as const

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x)
const ascii = (b: Uint8Array, at: number, text: string) => text.split('').every((c, i) => b[at + i] === c.charCodeAt(0))

/**
 * null = the bytes are plausibly this format; a string says why they are not.
 * Magic bytes for the binary formats, valid UTF-8 without a NUL for the text
 * ones, and an `<svg` tag for svg.
 */
export function sniffFormat(format: ArtifactFormat, bytes: Uint8Array): string | null {
  switch (format) {
    case 'pdf':
      return ascii(bytes, 0, '%PDF-') ? null : 'the file is not a PDF (no %PDF- header)'
    case 'png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : 'the file is not a PNG image'
    case 'jpg':
      return startsWith(bytes, [0xff, 0xd8, 0xff]) ? null : 'the file is not a JPEG image'
    case 'gif':
      return ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a') ? null : 'the file is not a GIF image'
    case 'webp':
      return ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP') ? null : 'the file is not a WebP image'
    default: {
      if (bytes.includes(0)) return `the file is not ${format} text (it holds NUL bytes, so it looks binary)`
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return `the file is not valid UTF-8 text, so it cannot be ${format}`
      }
      if (format === 'svg' && !/<svg[\s>]/i.test(text)) return 'the file has no <svg> element'
      return null
    }
  }
}

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
  /** file mtime and size at index time. The cheap "has it changed" check */
  mtime: number
  size: number
  format: ArtifactFormat
  /** 1-based: how many commits touched the file (see ArtifactVersion) */
  version: number
  /** false = the file is over 10 MB, so only its current bytes are kept */
  history: boolean
  /** set when the frontmatter did not parse and defaults were used */
  warning?: string
}

export type LinkKind = 'artifact' | 'item' | 'session'
export const LINK_KINDS: readonly LinkKind[] = ['artifact', 'item', 'session']
export const isLinkKind = (v: unknown): v is LinkKind => LINK_KINDS.includes(v as LinkKind)

/**
 * artifact→item: `brief` (the document about it: inherits the item's
 * lifecycle) or `context` (human notes it should be read with);
 * artifact→session: `context`, or `output` (a file that session published);
 * session→item: `dispatch` (the session works the item) or `brief` (the
 * session wrote its brief).
 */
export type LinkRole = 'brief' | 'report' | 'context' | 'dispatch' | 'plan' | 'output'
export const LINK_ROLES: readonly LinkRole[] = ['brief', 'report', 'context', 'dispatch', 'plan', 'output']
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
  /** create: md (default) or any format; a binary one needs `from`. Human callers write md only. */
  format?: ArtifactFormat
  /** model callers only: absolute path of a file junior copies in (a snapshot) */
  from?: string
  /** one line about this version */
  note?: string
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

/** md: `body` is the text without frontmatter; other text formats: the raw text. */
export type ArtifactContentResponse =
  | {
      ok: true
      artifact: Artifact
      body: string
      links: Link[]
      abs: string
      version: number
      latest: boolean
      /** pdf/png/jpg/gif/webp: `body` is '' , read the raw URL */
      binary: boolean
      /** `body` was cut at ARTIFACT_BODY_MAX_CHARS */
      truncated: boolean
    }
  | { ok: false; error: string }

export type ArtifactWriteAction = 'created' | 'updated' | 'unchanged'

export type ArtifactResponse =
  | { ok: true; artifact: Artifact; action?: ArtifactWriteAction; version?: number }
  | { ok: false; error: string }

/** One entry of GET /api/artifacts/versions, newest first. */
export type ArtifactVersion = {
  /** 1-based; the oldest commit of the file is v1 */
  version: number
  sha: string
  /** ms */
  at: number
  note?: string
  /** from the Junior-Session trailer of the commit */
  sessionId?: string
  /** the file's path at that commit (it can differ after a rename) */
  path: string
  current: boolean
}

export type ArtifactVersionsResponse =
  | { ok: true; history: boolean; current: number; versions: ArtifactVersion[]; capped: boolean; historyNote?: string }
  | { ok: false; error: string }

/**
 * The result text of the in-process write_artifact / update_artifact: the whole
 * text is this object as one line of JSON, so the transcript can fold it into a
 * card. Errors stay plain text with isError.
 */
export type ArtifactToolResult = {
  /** discriminator */
  junior: 'artifact'
  action: ArtifactWriteAction
  id: string
  title: string
  format: ArtifactFormat
  version: number
  /** bytes */
  size: number
  history: boolean
  /** relative to the artifacts folder */
  path: string
  abs: string
  hint?: string
}

export function parseArtifactResult(text: string): ArtifactToolResult | null {
  if (!text.startsWith('{')) return null
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  const r = v as Record<string, unknown> | null
  if (!r || typeof r !== 'object' || r.junior !== 'artifact') return null
  if (r.action !== 'created' && r.action !== 'updated' && r.action !== 'unchanged') return null
  if (typeof r.id !== 'string' || !r.id || typeof r.title !== 'string') return null
  if (!isArtifactFormat(r.format)) return null
  if (typeof r.version !== 'number' || typeof r.size !== 'number') return null
  if (typeof r.history !== 'boolean' || typeof r.path !== 'string' || typeof r.abs !== 'string') return null
  if (r.hint !== undefined && typeof r.hint !== 'string') return null
  return r as unknown as ArtifactToolResult
}

export type LinksResponse = { ok: true; links: Link[] } | { ok: false; error: string }
