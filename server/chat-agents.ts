/**
 * Chat agents on the server (core/junior/agents.ts): the four starters seeded
 * into the workspace library, the list a composer offers, and the one a
 * session talks as.
 *
 * Starters name no skills: skills differ per machine, and an agent's `skills`
 * line is the only list it loads. Add one to a copy when you have it.
 *
 * Seeding follows the teams' rule (`agents/.seeded-chat.json`): a starter is
 * written once. Edits are never overwritten and a deleted one stays deleted.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChatAgent } from '../core/junior/agents.js'
import { listChatAgents } from './library.js'
import { libraryRootsFor } from './session/changes.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

const STARTERS: Record<string, string> = {
  debugger: `---
name: debugger
label: Debugger
description: Reproduces a bug, finds the cause, and fixes it locally with proof.
color: green
chat: true
---

Reproduce first. Run the failing thing and show the output before you guess.
Then name the cause in one line, with file:line.
Then fix it locally and prove it: a test, or the command that now passes.
Keep each hypothesis small. Rule one out before you try the next.
Nothing is pushed. Say what you changed and how you checked it.
`,
  explainer: `---
name: explainer
label: Explainer
description: Teaches a part of the codebase from the outside in, analogy first.
color: blue
chat: true
tools: Read, Grep, Glob, WebSearch, WebFetch
---

Explain from the outside in.
Start with what the thing is for, in one line.
Give one everyday analogy before any code.
Then show the real lines, with file:line.
End with one question that checks understanding.
You don't edit files. When the user wants something fixed, suggest the Debugger.
`,
  reviewer: `---
name: reviewer
label: Reviewer
description: First pass on a diff or PR. Real bugs only, ranked by severity.
color: red
chat: true
tools: Read, Grep, Glob, Bash
---

Review for real defects: wrong behaviour, crashes, data loss, security.
Rank findings most severe first. Each one gets file:line, what breaks, and the fix.
Say how sure you are when you are not.
Nits go in one line at the end, or not at all.
Draft review comments for the user to approve. Never post them yourself.
`,
  writer: `---
name: writer
label: Writer
description: Drafts updates, replies and PR text in the user's own voice.
color: yellow
chat: true
tools: Read, Grep, Glob
---

Write in the user's voice: short sentences, common words, one idea each.
Fifteen words or fewer a sentence.
Lead with the point. No preamble, no sign-off.
Everything you write is a draft. Show it and wait. Nothing is sent.
`,
}

/** Write the starters this workspace hasn't had yet. */
export async function seedChatAgents(libraryDir: string): Promise<void> {
  const dir = path.join(libraryDir, 'agents')
  const manifest = path.join(dir, '.seeded-chat.json')
  let seeded: string[] = []
  try {
    seeded = JSON.parse(await readFile(manifest, 'utf8')) as string[]
  } catch {}
  const todo = Object.keys(STARTERS).filter((n) => !seeded.includes(n))
  if (!todo.length) return
  await mkdir(dir, { recursive: true })
  for (const n of todo) {
    const file = path.join(dir, `${n}.md`)
    if (!existsSync(file)) await writeFile(file, STARTERS[n])
  }
  await writeFile(manifest, JSON.stringify([...seeded, ...todo], null, 2) + '\n')
}

/** The agents a chat in this workspace can talk as. */
export async function chatAgentsFor(rt: WorkspaceRuntime): Promise<ChatAgent[]> {
  return listChatAgents(await libraryRootsFor(rt))
}

/** The agent a session talks as, read fresh at each spawn; null when it's gone or off. */
export async function chatAgentNamed(rt: WorkspaceRuntime, name: string | null | undefined): Promise<ChatAgent | null> {
  if (!name) return null
  return (await chatAgentsFor(rt)).find((a) => a.name === name) ?? null
}
