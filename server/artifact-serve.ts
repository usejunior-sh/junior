/**
 * The headers a raw artifact is served with (GET /api/artifacts/raw). Pure, so
 * the security rules are one table a test can read.
 *
 * A generated page must never reach /api, and a file must never be sniffed
 * into something else. Every response carries `nosniff` and the right type.
 * The CSP `sandbox` directive is what protects the document when it is opened
 * on its own (an opaque origin, no cookies, no same-origin fetch), so it does
 * not depend on the `sandbox` attribute of the iframe that usually frames it;
 * the iframe adds that as a second layer. Scripts are off unless the viewer
 * asks, and even then the page is sandboxed without `allow-same-origin` and
 * may not connect anywhere. PDF is the one format without a CSP sandbox:
 * Chrome's PDF viewer will not load inside a sandboxed document.
 */
import { type ArtifactFormat, formatMime } from '../shared/protocol.js'
import type { Access } from './remote.js'

/** Under /api/, so the gate in front of every /api route (denied → 401, paired rules) covers it unchanged. */
export const ARTIFACT_RAW_PATH = '/api/artifacts/raw'

/** Editors open on the Mac: why a request that is not from this machine may not ask for one, or null. */
export const openDenied = (access: Access): string | null =>
  access === 'local' ? null : 'editors open on the Mac — use it there'

export type RawHeaderOpts = {
  filename: string
  /** html only: let the page run scripts (still sandboxed, still no network) */
  scripts?: boolean
  /** save instead of show */
  download?: boolean
  /** a specific old version was asked for: its bytes can never change */
  versioned: boolean
  size: number
}

const HTML_BASE = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data:',
]
const HTML_TAIL = ["base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'"]

/** The Content-Security-Policy for a format, or none. */
export function rawCsp(format: ArtifactFormat, scripts = false): string | null {
  switch (format) {
    case 'html':
      return scripts
        ? ['sandbox allow-scripts', "default-src 'none'", "script-src 'unsafe-inline'", ...HTML_BASE.slice(1), "connect-src 'none'", ...HTML_TAIL].join('; ')
        : ['sandbox', ...HTML_BASE, ...HTML_TAIL].join('; ')
    case 'svg':
    case 'md':
    case 'csv':
    case 'txt':
    case 'json':
      // an svg opened as a top-level document would otherwise run its scripts
      return "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'"
    case 'png':
    case 'jpg':
    case 'gif':
    case 'webp':
      return "default-src 'none'; sandbox"
    case 'pdf':
      return null
  }
}

/** A name safe inside a quoted header value. */
const asciiName = (s: string): string => s.replace(/[^\x20-\x7e]|["\\]/g, '_')

export function rawHeaders(format: ArtifactFormat, o: RawHeaderOpts): Record<string, string> {
  const csp = rawCsp(format, o.scripts === true)
  return {
    'X-Content-Type-Options': 'nosniff',
    'Content-Type': formatMime(format),
    'Content-Disposition': `${o.download ? 'attachment' : 'inline'}; filename="${asciiName(o.filename)}"; filename*=UTF-8''${encodeURIComponent(o.filename)}`,
    'Content-Length': String(o.size),
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': o.versioned ? 'private, max-age=31536000, immutable' : 'private, no-cache',
    ...(csp ? { 'Content-Security-Policy': csp } : {}),
  }
}
