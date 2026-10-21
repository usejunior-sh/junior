import path from 'node:path'
import { type ClientMessage, type EffortLevel, type ImageAttachment, isEffortLevel, isImageMediaType, isMentionKind, isProviderId, isSessionMode, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE, MAX_MENTIONS_PER_MESSAGE, type Mention, type QuestionAnswers } from '../../shared/protocol.js'

const effort = (v: unknown): EffortLevel | undefined => (isEffortLevel(v) ? v : undefined)


/**
 * Unrecognized modes fall through to `undefined`, i.e. ask. A frame the
 * server does not understand must never widen what a session may do.
 */

/**
 * AskUserQuestion answers off the socket: a flat string→string map, or nothing.
 * Non-string values are dropped rather than passed through. This object is
 * merged into a tool's input.
 */
const questionAnswers = (v: unknown): QuestionAnswers | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: QuestionAnswers = {}
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length > 0 ? out : undefined
}

/** Rough decoded size of a base64 payload, without decoding it. */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4)

export const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Image attachments off the socket. Anything malformed, oversized, or of an
 * unsupported media type is dropped rather than forwarded. These bytes go
 * both into the event log and up to the API.
 */
const imageAttachments = (v: unknown): ImageAttachment[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: ImageAttachment[] = []
  for (const raw of v.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const a = raw as Record<string, unknown>
    if (!isImageMediaType(a.mediaType)) continue
    if (typeof a.data !== 'string' || !a.data || !BASE64.test(a.data)) continue
    if (base64Bytes(a.data) > MAX_IMAGE_BYTES) continue
    out.push({
      mediaType: a.mediaType,
      data: a.data,
      name: typeof a.name === 'string' && a.name ? a.name.slice(0, 200) : undefined,
    })
  }
  return out.length > 0 ? out : undefined
}

const mentionList = (v: unknown): Mention[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const out: Mention[] = []
  for (const raw of v.slice(0, MAX_MENTIONS_PER_MESSAGE)) {
    if (typeof raw !== 'object' || raw === null) continue
    const m = raw as Record<string, unknown>
    if (!isMentionKind(m.kind)) continue
    if (typeof m.ref !== 'string' || !m.ref || m.ref.length > 1024) continue
    // Paths are resolved against the session folder later; an absolute path
    // or a `..` hop is refused here so the resolver only ever sees relatives.
    if (m.kind === 'file' && (path.isAbsolute(m.ref) || m.ref.split('/').includes('..'))) continue
    out.push({
      kind: m.kind,
      ref: m.ref,
      label: typeof m.label === 'string' && m.label ? m.label.slice(0, 200) : m.ref.slice(0, 200),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The socket is untrusted input, so incoming frames are
 * validated into the ClientMessage union rather than cast into it.
 */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const model = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  switch (m.type) {
    case 'create_session':
      return {
        type: 'create_session',
        title: str(m.title),
        cwd: str(m.cwd),
        projectId: typeof m.projectId === 'string' && m.projectId ? m.projectId : undefined,
        checkoutId: typeof m.checkoutId === 'string' && m.checkoutId ? m.checkoutId : undefined,
        worktree:
          typeof m.worktree === 'object' && m.worktree !== null && typeof (m.worktree as { branch?: unknown }).branch === 'string'
            ? { branch: str((m.worktree as { branch: string }).branch).trim().slice(0, 200) }
            : undefined,
        firstMessage: typeof m.firstMessage === 'string' ? m.firstMessage : undefined,
        images: imageAttachments(m.images),
        files: Array.isArray(m.files) ? (m.files as unknown[]).map((f) => (typeof f === 'string' ? f : '')) : undefined,
        mentions: mentionList(m.mentions),
        model: model(m.model),
        effort: effort(m.effort),
        fastMode: m.fastMode === true,
        mode: isSessionMode(m.mode) ? m.mode : undefined,
        // An agent this build doesn't know is dropped: the session runs on Claude.
        provider: isProviderId(m.provider) ? m.provider : undefined,
        itemId: typeof m.itemId === 'string' && m.itemId ? m.itemId : undefined,
      }
    case 'set_model':
      return typeof m.sessionId === 'string'
        ? { type: 'set_model', sessionId: m.sessionId, model: model(m.model), effort: effort(m.effort) }
        : null
    case 'set_fast_mode':
      // Anything but an explicit true is off. The paid-for mode is the one
      // that has to be asked for exactly.
      return typeof m.sessionId === 'string'
        ? { type: 'set_fast_mode', sessionId: m.sessionId, fastMode: m.fastMode === true }
        : null
    case 'set_session_mode':
      return typeof m.sessionId === 'string' && (m.mode === 'normal' || m.mode === 'plan')
        ? { type: 'set_session_mode', sessionId: m.sessionId, mode: m.mode }
        : null
    case 'set_ultracode':
      // Like fast mode, the mode that costs more has to be asked for exactly.
      return typeof m.sessionId === 'string' ? { type: 'set_ultracode', sessionId: m.sessionId, on: m.on === true } : null
    case 'rename_session':
      return typeof m.sessionId === 'string'
        ? { type: 'rename_session', sessionId: m.sessionId, title: str(m.title) }
        : null
    case 'set_pinned':
      return typeof m.sessionId === 'string'
        ? { type: 'set_pinned', sessionId: m.sessionId, pinned: m.pinned === true }
        : null
    case 'delete_session':
      return typeof m.sessionId === 'string' ? { type: 'delete_session', sessionId: m.sessionId } : null
    case 'subscribe':
      return typeof m.sessionId === 'string' ? { type: 'subscribe', sessionId: m.sessionId } : null
    case 'user_message':
      return typeof m.sessionId === 'string'
        ? {
            type: 'user_message',
            sessionId: m.sessionId,
            text: str(m.text),
            images: imageAttachments(m.images),
            files: Array.isArray(m.files) ? (m.files as unknown[]).map((f) => (typeof f === 'string' ? f : '')) : undefined,
            mentions: mentionList(m.mentions),
            ...(m.mode === 'goal' ? { mode: 'goal' as const } : {}),
          }
        : null
    case 'permission_response':
      return typeof m.sessionId === 'string' && typeof m.requestId === 'string'
        ? {
            type: 'permission_response',
            sessionId: m.sessionId,
            requestId: m.requestId,
            // Anything unrecognized is a denial: the permissive readings are
            // the ones that have to be spelled out exactly.
            behavior:
              m.behavior === 'allow' ? 'allow' : m.behavior === 'allow_always' ? 'allow_always' : 'deny',
            answers: questionAnswers(m.answers),
          }
        : null
    case 'interrupt':
      return typeof m.sessionId === 'string' ? { type: 'interrupt', sessionId: m.sessionId } : null
    case 'agent_stop':
      return typeof m.sessionId === 'string' && typeof m.agentId === 'string' && m.agentId
        ? { type: 'agent_stop', sessionId: m.sessionId, agentId: m.agentId }
        : null
    case 'agent_background':
      return typeof m.sessionId === 'string' && typeof m.toolUseId === 'string' && m.toolUseId
        ? { type: 'agent_background', sessionId: m.sessionId, toolUseId: m.toolUseId }
        : null
    case 'agent_message': {
      const r = (typeof m.relay === 'object' && m.relay !== null ? m.relay : {}) as Record<string, unknown>
      // The agent id is spliced into the prompt main reads: an id, nothing else.
      const agentId = typeof r.agentId === 'string' && /^[\w-]{1,64}$/.test(r.agentId) ? r.agentId : ''
      const relay = { toolUseId: str(r.toolUseId), agentId, label: str(r.label).replace(/\s+/g, ' ').replace(/"/g, "'").slice(0, 120) }
      return typeof m.sessionId === 'string' && relay.toolUseId && relay.agentId && str(m.text).trim()
        ? { type: 'agent_message', sessionId: m.sessionId, relay, text: str(m.text).trim() }
        : null
    }
    case 'terminal_create':
      return {
        type: 'terminal_create',
        cwd: typeof m.cwd === 'string' && m.cwd ? m.cwd : undefined,
        projectId: typeof m.projectId === 'string' && m.projectId ? m.projectId : undefined,
        checkoutId: typeof m.checkoutId === 'string' && m.checkoutId ? m.checkoutId : undefined,
        title: typeof m.title === 'string' && m.title ? m.title : undefined,
        command: typeof m.command === 'string' && m.command ? m.command : undefined,
      }
    case 'terminal_input':
      return typeof m.terminalId === 'string' && typeof m.data === 'string'
        ? { type: 'terminal_input', terminalId: m.terminalId, data: m.data }
        : null
    case 'terminal_resize':
      return typeof m.terminalId === 'string' && Number.isFinite(m.cols) && Number.isFinite(m.rows)
        ? { type: 'terminal_resize', terminalId: m.terminalId, cols: Number(m.cols), rows: Number(m.rows) }
        : null
    case 'terminal_subscribe':
      return typeof m.terminalId === 'string' ? { type: 'terminal_subscribe', terminalId: m.terminalId } : null
    case 'terminal_rename':
      return typeof m.terminalId === 'string'
        ? { type: 'terminal_rename', terminalId: m.terminalId, title: str(m.title) }
        : null
    case 'terminal_close':
      return typeof m.terminalId === 'string' ? { type: 'terminal_close', terminalId: m.terminalId } : null
    default:
      return null
  }
}
