/**
 * Posting a first pass (core/review/post.ts): the diff's lines, comments off
 * the diff folded into the body, your edits win, and a review GitHub would
 * refuse is refused here first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FirstPass } from '../core/review/brief.js'
import { diffLines, postedLine, postEditFrom, reviewPayload } from '../core/review/post.js'

const DIFF = `diff --git a/src/cache.ts b/src/cache.ts
index 111..222 100644
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -8,4 +8,5 @@ export class Cache {
   get(k) {
-    return this.m[k]
+    const v = this.m[k]
+    return v
   }
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1
+export const b = 2
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-x
`

test('the diff’s lines: context and added on the right, context and removed on the left', () => {
  const l = diffLines(DIFF)
  assert.deepEqual([...l.get('src/cache.ts')!.right].sort((a, b) => a - b), [8, 9, 10, 11, 12])
  assert.deepEqual([...l.get('src/cache.ts')!.left].sort((a, b) => a - b), [8, 9, 10, 11])
  assert.deepEqual([...l.get('src/new.ts')!.right], [1, 2])
  assert.equal(l.has('src/gone.ts'), false, 'a deleted file has no new side')
})

const pass: FirstPass = {
  verdict: 'request_changes',
  summary: 'The cache never expires.',
  comments: [
    { path: 'src/cache.ts', line: 9, body: 'Why the temp?' },
    { path: 'src/cache.ts', line: 9, side: 'LEFT', body: 'Old line.' },
    { path: 'src/other.ts', line: 3, body: 'Not in the diff.' },
  ],
  sha: 'a'.repeat(40),
}

test('on-diff comments go inline, the rest into the body with their place', () => {
  const { payload, inline, folded } = reviewPayload(pass, {}, diffLines(DIFF))
  assert.equal(payload.commit_id, 'a'.repeat(40))
  assert.equal(payload.event, 'REQUEST_CHANGES')
  assert.deepEqual(payload.comments, [
    { path: 'src/cache.ts', line: 9, side: 'RIGHT', body: 'Why the temp?' },
    { path: 'src/cache.ts', line: 9, side: 'LEFT', body: 'Old line.' },
  ])
  assert.equal(payload.body, 'The cache never expires.\n\n**`src/other.ts:3`**: Not in the diff.')
  assert.deepEqual([inline, folded], [2, 1])
  assert.equal(postedLine(payload), 'Posted: Request changes · 2 comments')
})

test('your edits win; emptied comments are dropped', () => {
  const { payload } = reviewPayload(pass, { verdict: 'approve', body: 'LGTM', comments: [{ path: 'src/new.ts', line: 2, body: '  ' }] }, diffLines(DIFF))
  assert.deepEqual([payload.event, payload.body, payload.comments.length], ['APPROVE', 'LGTM', 0])
  assert.equal(postedLine(payload), 'Posted: Approve')
})

test('a review GitHub would refuse is refused here', () => {
  assert.throws(() => reviewPayload(pass, { body: '', comments: [] }, diffLines(DIFF)), /needs a body or a comment/)
  assert.throws(() => reviewPayload(pass, { body: '', comments: [{ path: 'src/new.ts', line: 1, body: 'x' }] }, diffLines(DIFF)), /say what has to change/)
  assert.doesNotThrow(() => reviewPayload(pass, { verdict: 'comment', body: '', comments: [{ path: 'src/new.ts', line: 1, body: 'x' }] }, diffLines(DIFF)))
  assert.doesNotThrow(() => reviewPayload(pass, { verdict: 'approve', body: '', comments: [] }, diffLines(DIFF)))
})

test('the edit from the wire is checked, not guessed', () => {
  assert.deepEqual(postEditFrom({ id: 'x', verdict: 'comment', body: 'b', comments: [{ path: 'a.ts', line: 3, body: 'c', side: 'LEFT' }] }), {
    verdict: 'comment',
    body: 'b',
    comments: [{ path: 'a.ts', line: 3, side: 'LEFT', body: 'c' }],
  })
  assert.deepEqual(postEditFrom({}), {})
  assert.throws(() => postEditFrom({ verdict: 'merge' }), /verdict/)
  assert.throws(() => postEditFrom({ comments: [{ path: 'a.ts', line: 0, body: 'c' }] }), /comment 1/)
})
