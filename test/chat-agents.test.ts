/**
 * Chat agents (core/junior/agents.ts): which agent files a chat can talk as,
 * their face colours (never orange), their name after Junior's, and that an
 * agent only narrows tools and keeps the rules last. Plus the starters' seed:
 * written once, edits kept, a deleted one stays deleted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { agentAppend, agentDisallowed, agentFace, agentTitle, chatAgentFrom } from '../core/junior/agents.js'
import { seedChatAgents } from '../server/chat-agents.js'
import { listChatAgents, type LibraryRoot } from '../server/library.js'

const at = { name: 'junior:explainer', slug: 'explainer', path: '/x/explainer.md', scope: 'Workspace' }

test('only an agent file with chat: true is a chat agent', () => {
  assert.equal(chatAgentFrom('---\nname: explainer\ndescription: d\n---\nbody', at), null)
  assert.equal(chatAgentFrom('---\nname: explainer\nchat: false\n---\nbody', at), null)
  const a = chatAgentFrom('---\nname: explainer\nchat: true\ncolor: blue\nskills: book, indian-mode\ntools: [Read, Grep]\nmodel: inherit\n---\nExplain.\n', at)!
  assert.equal(a.label, 'Explainer')
  assert.equal(a.colour, '#a9cdfc')
  assert.deepEqual(a.skills, ['book', 'indian-mode'])
  assert.deepEqual(a.tools, ['Read', 'Grep'])
  assert.equal(a.model, null)
  assert.equal(a.prompt, 'Explain.')
})

test('a label wins over the file name, and the name is Junior first', () => {
  const a = chatAgentFrom('---\nname: code-reviewer\nlabel: Reviewer\nchat: yes\n---\n', { ...at, slug: 'code-reviewer' })!
  assert.equal(a.label, 'Reviewer')
  assert.equal(agentTitle('Junior', a.label), 'Junior · Reviewer')
  assert.equal(agentTitle('Nova', null), 'Nova')
  assert.equal(chatAgentFrom('---\nname: code-reviewer\nchat: true\n---\n', at)!.label, 'Code reviewer')
})

test('faces: named colours and hex, but never orange', () => {
  assert.equal(agentFace('green'), '#7fe0b4')
  assert.equal(agentFace('#ABCDEF'), '#abcdef')
  assert.equal(agentFace('orange'), null)
  assert.equal(agentFace('chartreuse'), null)
  assert.equal(agentFace(undefined), null)
})

test('tools only narrow: the gated built-ins it leaves out are taken away, nothing is added', () => {
  assert.deepEqual(agentDisallowed({ tools: null }), [])
  const off = agentDisallowed({ tools: ['Read', 'Grep', 'Glob'] })
  assert.ok(off.includes('Bash') && off.includes('Edit') && off.includes('Write'))
  assert.ok(!off.includes('Read'))
  assert.ok(!off.includes('Skill') && !off.includes('AskUserQuestion'))
})

test('the prompt names the agent and points elsewhere instead of switching', () => {
  const a = chatAgentFrom('---\nname: explainer\nchat: true\ndescription: Teaches code.\n---\nAnalogy first.\n', at)!
  const p = agentAppend(a, 'Junior')
  assert.match(p, /You are Junior · Explainer/)
  assert.match(p, /Teaches code\./)
  assert.match(p, /Analogy first\./)
  assert.match(p, /Never switch on your own/)
})

test('starters are seeded once: edits kept, a deleted one stays deleted', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'junior-chat-agents-'))
  try {
    await seedChatAgents(dir)
    const agents = path.join(dir, 'agents')
    for (const n of ['debugger', 'explainer', 'reviewer', 'writer']) assert.ok(existsSync(path.join(agents, `${n}.md`)), n)
    await writeFile(path.join(agents, 'writer.md'), '---\nname: writer\nchat: true\n---\nmine\n')
    await rm(path.join(agents, 'debugger.md'))
    await seedChatAgents(dir)
    assert.equal(existsSync(path.join(agents, 'debugger.md')), false)
    assert.match(await readFile(path.join(agents, 'writer.md'), 'utf8'), /mine/)

    const root: LibraryRoot = { id: 'workspace', source: 'workspace', label: 'Workspace', dir, editable: true, namespace: 'junior' }
    const list = await listChatAgents([root])
    assert.deepEqual(list.map((a) => a.name).sort(), ['junior:explainer', 'junior:reviewer', 'junior:writer'])
    assert.ok(list.filter((a) => a.slug !== 'writer').every((a) => a.colour), 'every untouched starter has a face colour')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
