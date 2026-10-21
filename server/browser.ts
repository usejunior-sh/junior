/**
 * The browser, daemon side (.docs/browser.md). Triage.app hosts the tabs, one
 * per session, and runs CDP commands on them; this module is everything
 * above that: the host connection, the `browser` MCP server each chat gets,
 * page logs per session, and the evidence (screenshots, checkpoints, diffs)
 * kept on disk under the workspace.
 *
 * Scope is enforced here, not asked for: a session's tools only ever name
 * that session's tab, and the app only attaches a debugger to tabs.
 */
export { NO_HOST, VIEWPORTS, BrowserHub, downloadDirFor } from './browser/hub.js'
export type { ShotKind, Shot } from './browser/hub.js'
export { PageDriver } from './browser/page-driver.js'
export { viewportLabel, ShotStore, shotUrl, renderVerification, shotMarker, SHOT_MARKER_RE } from './browser/evidence.js'
export type { VerifiedTurn } from './browser/evidence.js'
export { inspectElement, formatInspected, describePicked } from './browser/tool-kit.js'
export type { BrowserToolContext } from './browser/tool-kit.js'
export { makeBrowserMcp } from './browser/mcp.js'
export { browserGate } from './browser/gate.js'
export type { BrowserGate, BrowserGateContext } from './browser/gate.js'

