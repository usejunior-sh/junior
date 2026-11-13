import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendArchive, forget, MEMORY_LINE_MAX, MEMORY_MAX_BYTES, memoryAppend, parseMemory, remember, serializeMemory } from '../core/junior/memory.js'

const now = new Date(2026, 10, 14, 12).getTime()

test('a fact is kept as a dated line, and the file round-trips', () => {
  const { lines } = remember([], { text: 'Priya owns  the\nbilling service.' }, now)
  assert.deepEqual(lines, [{ day: '2026-11-14', text: 'Priya owns the billing service.' }])
  assert.deepEqual(parseMemory(serializeMemory(lines)), lines)
  assert.match(serializeMemory(lines), /^# Junior's memory\n/)
})

test('lines the user wrote by hand are kept; headings and prose are not memories', () => {
  const lines = parseMemory('# Junior\'s memory\n\nSome prose.\n- 2026-11-01 · Dated fact\n- hand-written fact\n')
  assert.deepEqual(lines, [{ day: '2026-11-01', text: 'Dated fact' }, { text: 'hand-written fact' }])
})

test('the same words twice keep one line', () => {
  const first = remember([], { text: 'Billing is in Go.' }, now)
  const again = remember(first.lines, { text: 'billing is in go.' }, now)
  assert.equal(again.lines.length, 1)
  assert.equal(again.existed, true)
})

test('replaces swaps the one matching line; none or several is an error', () => {
  let lines = remember([], { text: 'Migration is blocked on Priya.' }, now).lines
  lines = remember(lines, { text: 'Billing is in Go.' }, now).lines
  const r = remember(lines, { text: 'Migration shipped on Nov 14.', replaces: 'migration' }, now)
  assert.equal(r.replaced?.text, 'Migration is blocked on Priya.')
  assert.deepEqual(
    r.lines.map((l) => l.text),
    ['Billing is in Go.', 'Migration shipped on Nov 14.'],
  )
  assert.throws(() => remember(lines, { text: 'x', replaces: 'nothing like it' }, now), /no memory line contains/)
  assert.throws(() => remember(lines, { text: 'x', replaces: 'i' }, now), /2 memory lines contain/)
})

test('forget drops the one matching line', () => {
  const lines = remember(remember([], { text: 'A is true.' }, now).lines, { text: 'B is true.' }, now).lines
  const r = forget(lines, 'a is')
  assert.equal(r.forgot.text, 'A is true.')
  assert.equal(r.lines.length, 1)
  assert.throws(() => forget(lines, 'is true'), /2 memory lines/)
})

test('a full file moves its oldest lines to the archive and stays under the cap', () => {
  let lines = remember([], { text: 'oldest fact' }, now).lines
  let archived: string[] = []
  for (let i = 0; i < 60; i++) {
    const r = remember(lines, { text: `fact number ${i} ${'x'.repeat(80)}` }, now)
    lines = r.lines
    archived = [...archived, ...r.archived.map((l) => l.text)]
  }
  assert.ok(new TextEncoder().encode(serializeMemory(lines)).length <= MEMORY_MAX_BYTES)
  assert.equal(archived[0], 'oldest fact')
  assert.match(lines[lines.length - 1].text, /^fact number 59/)
  assert.match(appendArchive('', [{ day: '2026-11-14', text: 'oldest fact' }]), /archive[\s\S]*- 2026-11-14 · oldest fact\n$/)
})

test('a long line is cut and invisible characters go', () => {
  const { lines } = remember([], { text: `a​b ${'y'.repeat(400)}` }, now)
  assert.ok(lines[0].text.startsWith('ab '))
  assert.equal(lines[0].text.length, MEMORY_LINE_MAX)
})

test('the prompt block says what goes where, with the lines or "nothing yet"', () => {
  assert.match(memoryAppend([]), /## Your memory[\s\S]*propose_learning[\s\S]*pin_note[\s\S]*\(nothing yet\)/)
  assert.match(memoryAppend([{ day: '2026-11-14', text: 'Billing is in Go.' }]), /\n- 2026-11-14 · Billing is in Go\.$/)
})
