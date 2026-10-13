/**
 * What triage tells a model about itself — the one place the product explains
 * its own vocabulary, split by how often each layer changes:
 *
 *   static concepts  → `TRIAGE_MCP_INSTRUCTIONS`, the MCP server's `instructions`
 *                      block. Identical for every session and every workspace,
 *                      so it caches; carried on both transports (the in-process
 *                      server in server/index.ts and the stdio shim in
 *                      server/mcp.ts) because both expose the same tools.
 *   session identity → `triageSessionAppend()`, appended to Claude Code's own
 *                      system prompt at spawn so it survives `resume`. Workspace,
 *                      session id, artifacts folder — known at spawn, fixed for
 *                      the session's life.
 *   live state       → neither. Which items are open and which artifacts exist
 *                      is a tool call away and stale a turn later; putting it in
 *                      a prompt re-bills it every turn to say something wrong.
 *
 * Dependency-free on purpose: the stdio shim imports only `node:readline` and
 * this file, so it stays a shim.
 */

/** `instructions` for the triage MCP server — the vocabulary, not the contents. */
export const TRIAGE_MCP_INSTRUCTIONS = `Triage is a local work inbox for one engineer. It ranks what actually needs them — GitHub, Slack, Linear, and their own to-dos — and runs one loop: identify → brief → dispatch. These tools are that inbox. Everything is on this machine; nothing here posts anywhere.

- work item — one piece of work, id-keyed: "github:owner/repo#12", "slack:…", "linear:KEY-1", "manual:<uuid>". Scanned items are upserted by their scanner and update-only-if-newer, so only "manual:" items can be edited here. Status is open, snoozed, done or archived; list_work_items shows open ones by default, get_work_item reads any of them.
- artifact — a markdown file in the workspace's artifacts folder, committed to git on every write. Its author is "human" or "model": you may rewrite artifacts you wrote, and human-authored ones are refused to you — read them, cite them, propose changes in the chat, never overwrite them.
- link — an artifact or a session attached to a work item, with a role. "brief" is the single research document about an item; "context" is a note to read alongside it; "dispatch" is the session doing the work. Attach a note with write_artifact's \`links\`, or link_artifact after the fact.
- brief — a model-written artifact about one item, produced by a headless run against a playbook. Read the brief before starting work on an item.
- playbook / dispatch template — the user's own prose for how a kind of item gets briefed and how its session opens. User-owned files; not yours to rewrite.

list_work_items, get_work_item, get_session_context, list_artifacts and read_artifact are free reads — use them rather than guessing. Every other tool writes, and the user is asked first.`

export type TriageSessionKind = 'chat' | 'watch-run' | 'brief'

export type TriageSessionIdentity = {
  /** the triage session id — the handle for get_session_context and `links` */
  sessionId: string
  workspaceId: string
  workspaceName: string
  /** absolute path of the workspace's artifacts folder */
  artifactsRoot: string
  /** the workspace's own skills and agents — a plugin its chat sessions load as `triage:` */
  libraryRoot?: string
}

/**
 * The system-prompt append for a triage-spawned session: who it is and where to
 * look. Deliberately says "look it up" rather than naming the work item — a
 * session is spawned before `create_session` links it to one (server/index.ts),
 * so at spawn time there is nothing true to say about it.
 */
export function triageSessionAppend(kind: TriageSessionKind, id: TriageSessionIdentity): string {
  const head = `
You are running inside triage, a local work inbox, in its "${id.workspaceName}" workspace (id ${id.workspaceId}).
This conversation is triage session ${id.sessionId}. The workspace's artifacts — markdown notes and briefs,
git-tracked — live at ${id.artifactsRoot}. Reach all of it through the mcp__triage__* tools.

Nothing about the current state of the inbox is in this prompt, because it would be out of date by the time
you read it. Look it up instead: get_session_context with this session's id says which work item this session
was opened for and which artifacts are attached to it; get_work_item follows any item id, at any status.`

  if (kind === 'brief') return head

  return `${head}
When the user says to write something down, note it, or attach it here, that means write_artifact — with
\`links\` naming this session ({ kind: "session", id: "${id.sessionId}", role: "context" }) and the work item
too when there is one, so the note comes back with the work rather than getting lost in the transcript.${id.libraryRoot ? librarySection(id.libraryRoot) : ''}`
}

/**
 * Where a skill or agent the user asks for should go. Triage reloads skills
 * and agents in every live session when a turn writes one, so it is usable
 * straight away — say so rather than telling the user to restart.
 */
const librarySection = (root: string) => `

When the user asks you to create or change a skill or a subagent, write Claude Code's own file format:
a skill is <dir>/skills/<name>/SKILL.md (frontmatter: name, description; then the instructions), an agent
is <dir>/agents/<name>.md (frontmatter: name, description, optional tools and model; then its system prompt).
Put it where the user says. With no preference: this workspace's library, ${root} (its skills load as
/triage:<name> in this workspace's sessions); ~/.claude for "personal" or "everywhere"; <project>/.claude for
one repo. Triage reloads skills and agents in every open session once your turn ends, so it is usable at once.`
