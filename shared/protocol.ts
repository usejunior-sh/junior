/**
 * The WebSocket contract between the triage server and its frontends.
 *
 * This is the only thing a frontend is allowed to know about the server —
 * "thin frontends, fat core" (see .docs/vision.md). Both `server/` and `web/`
 * import this file, so a change to the wire format is a compile error on the
 * side that did not keep up.
 */

export * from './protocol/workspace.js'
export * from './protocol/library.js'
export * from './protocol/team-runs.js'
export * from './protocol/session.js'
export * from './protocol/sdk.js'
export * from './protocol/catalog.js'
export * from './protocol/inbox.js'
export * from './protocol/system.js'
export * from './protocol/projects.js'
export * from './protocol/jobs.js'
export * from './protocol/attachments.js'
export * from './protocol/artifacts.js'
export * from './protocol/briefs.js'
export * from './protocol/junior.js'
export * from './protocol/actions.js'
export * from './protocol/mentions.js'
export * from './protocol/wire.js'
export * from './protocol/goals.js'
export * from './protocol/browser.js'

