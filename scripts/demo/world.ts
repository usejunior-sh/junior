// The demo world: a believable week for "Alex", an engineer at Acme, as
// triage would hold it. Pure data: seed.ts writes it into a store. Every time
// is relative to `now`, so a fresh seed always looks like today.
//
// Rules this file keeps (each one is a way a demo inbox goes wrong):
// - no `#123` / `ABC-12` in titles unless items should fold together (link.ts)
// - FYI-ish items stay fresh, or fade.ts archives them
// - GitHub items only use repos listed in REPOS (scopeGitHub)

export { LOGIN, WORKSPACE_NAME, REPOS, MODEL, ID } from './world/base.js'
export { items, manuals } from './world/items.js'
export type { DemoItem, DemoManual } from './world/items.js'
export { sessions } from './world/sessions.js'
export type { Step, DemoSession } from './world/sessions.js'
export { jobs } from './world/jobs.js'
export type { DemoJob } from './world/jobs.js'
export { artifacts, REPO_FILES, REPO_EDITS } from './world/artifacts.js'
export type { DemoArtifact } from './world/artifacts.js'

