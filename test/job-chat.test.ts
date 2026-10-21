/**
 * Jobs are set up by chatting with Junior (shared/triageContext.ts): every
 * chat knows how; headless sessions never carry it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOBS_SECTION, triageSessionAppend } from '../shared/triageContext.js'

const id = { sessionId: 's1', workspaceId: 'w', workspaceName: 'W', artifactsRoot: '/tmp/a' }

test('a chat learns to set up a job: read back, one message of questions, draft, trial run', () => {
  const chat = triageSessionAppend('chat', id)
  assert.ok(chat.includes(JOBS_SECTION))
  for (const step of ['Read it back', 'ONE message', 'draft_job', 'try_job', 'New job:']) assert.ok(JOBS_SECTION.includes(step), step)
})

test('a job that reads web pages: Junior asks which browser profile, suggesting the default', () => {
  assert.match(JOBS_SECTION, /which browser profile/)
  assert.match(JOBS_SECTION, /suggest the workspace default/)
})

test('job runs and briefs are headless — no job setup in their prompt', () => {
  assert.ok(!triageSessionAppend('job-run', id).includes(JOBS_SECTION))
  assert.ok(!triageSessionAppend('brief', id).includes(JOBS_SECTION))
})
