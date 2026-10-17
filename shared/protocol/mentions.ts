

// Mentions: `@` references typed into a composer. Claude Code's own `@file`
// is a feature of its terminal UI, not of the agent: the SDK passes text
// through verbatim. So the composer picks, the server resolves at send time,
// and the model gets the content as extra blocks on the same message. One
// shape for every kind so the picker, the chips and the wire grow together.
// Adding a kind (an artifact, say) is a new `MentionKind` plus a resolver.

export const MENTION_KINDS = ['file', 'item', 'session', 'artifact'] as const
export type MentionKind = (typeof MENTION_KINDS)[number]

export const isMentionKind = (v: unknown): v is MentionKind =>
  typeof v === 'string' && (MENTION_KINDS as readonly string[]).includes(v)

export type Mention = {
  kind: MentionKind
  /**
   * file: a path relative to the session's folder (a trailing `/` means a
   * directory); item: a work item id; session: a session id; artifact: an
   * artifact id (the markdown body rides the message, like a small file).
   */
  ref: string
  /** what the chip shows: the basename, the item title, the session title */
  label: string
}

/** A mention after the server resolved it, what the model actually received. */
export type ResolvedMention = Mention & {
  /** file: size on disk */
  bytes?: number
  /** the body (file text, directory listing, item/session summary) rode the message */
  inlined?: boolean
  /** why only the reference itself was passed on */
  error?: string
}

/** The token the picker writes into the text for a mention, and how it reads back. */
export function mentionToken(m: Mention): string {
  if (m.kind === 'file') return /\s/.test(m.ref) ? `@"${m.ref}"` : `@${m.ref}`
  return `@${m.kind}:${m.ref}`
}

export const MAX_MENTIONS_PER_MESSAGE = 16
/** A text file above this rides as a path only; the model reads what it needs. */
export const MAX_INLINE_FILE_BYTES = 64 * 1024
/** Ceiling for everything inlined on one message, files and listings together. */
export const MAX_INLINE_TOTAL_BYTES = 200 * 1024

/** `GET /api/files/search?root=&q=&limit=`: fuzzy matches under one folder. */
export type FileHit = { path: string; dir: boolean }
export type FileSearchResponse =
  | { ok: true; root: string; hits: FileHit[]; total: number; truncated: boolean }
  | { ok: false; error: string }
