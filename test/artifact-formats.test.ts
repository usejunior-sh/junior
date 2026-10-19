/**
 * Artifact formats (shared/protocol/artifacts.ts) and the CSV reader
 * (shared/csv.ts): the format table, what the byte sniffer accepts and
 * refuses, the tool-result envelope the chat card is built from.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARTIFACT_FORMATS,
  type ArtifactToolResult,
  formatExt,
  formatMime,
  formatOfExt,
  isImageFormat,
  isTextFormat,
  parseArtifactResult,
  sniffFormat,
} from '../shared/protocol.js'
import { parseCsv } from '../shared/csv.js'

const bytes = (...n: number[]) => Uint8Array.from(n)
const text = (s: string) => new TextEncoder().encode(s)

test('format table: every format has a mime, an extension that maps back, and a kind', () => {
  assert.deepEqual([...ARTIFACT_FORMATS], ['md', 'html', 'csv', 'txt', 'json', 'svg', 'pdf', 'png', 'jpg', 'gif', 'webp'])
  const mime: Record<string, string> = {
    md: 'text/markdown; charset=utf-8',
    html: 'text/html; charset=utf-8',
    csv: 'text/csv; charset=utf-8',
    txt: 'text/plain; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  for (const f of ARTIFACT_FORMATS) {
    assert.equal(formatMime(f), mime[f])
    assert.equal(formatOfExt(formatExt(f)), f)
  }
  assert.deepEqual(ARTIFACT_FORMATS.filter(isTextFormat), ['md', 'html', 'csv', 'txt', 'json', 'svg'])
  assert.deepEqual(ARTIFACT_FORMATS.filter(isImageFormat), ['svg', 'png', 'jpg', 'gif', 'webp'])
})

test('formatOfExt: dots, case and aliases', () => {
  assert.equal(formatOfExt('.HTML'), 'html')
  assert.equal(formatOfExt('htm'), 'html')
  assert.equal(formatOfExt('.jpeg'), 'jpg')
  assert.equal(formatOfExt('markdown'), 'md')
  assert.equal(formatOfExt('exe'), null)
  assert.equal(formatOfExt(''), null)
})

test('sniffFormat: magic bytes for the binary formats', () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3)
  assert.equal(sniffFormat('png', png), null)
  assert.match(sniffFormat('jpg', png) ?? '', /not a JPEG/)
  assert.equal(sniffFormat('jpg', bytes(0xff, 0xd8, 0xff, 0xe0)), null)
  assert.equal(sniffFormat('gif', text('GIF89a....')), null)
  assert.equal(sniffFormat('gif', text('GIF87a....')), null)
  assert.match(sniffFormat('gif', text('GIF88a')) ?? '', /not a GIF/)
  assert.equal(sniffFormat('webp', text('RIFF\0\0\0\0WEBPVP8 ')), null)
  assert.match(sniffFormat('webp', text('RIFF\0\0\0\0WAVEfmt ')) ?? '', /not a WebP/)
  assert.equal(sniffFormat('pdf', text('%PDF-1.7\n')), null)
  assert.match(sniffFormat('pdf', text('<html>')) ?? '', /not a PDF/)
  assert.match(sniffFormat('png', text('hello')) ?? '', /not a PNG/)
  assert.match(sniffFormat('png', new Uint8Array(0)) ?? '', /not a PNG/)
})

test('sniffFormat: text formats are UTF-8 with no NUL', () => {
  for (const f of ['md', 'html', 'csv', 'txt', 'json'] as const) assert.equal(sniffFormat(f, text('héllo, wörld ✓')), null)
  assert.match(sniffFormat('txt', bytes(0x68, 0xff, 0xfe, 0x69)) ?? '', /not valid UTF-8/)
  assert.match(sniffFormat('csv', text('a,b\0c')) ?? '', /NUL/)
  assert.match(sniffFormat('html', bytes(0x89, 0x50, 0x4e, 0x47, 0, 0)) ?? '', /NUL/)
  assert.equal(sniffFormat('txt', new Uint8Array(0)), null)
})

test('sniffFormat: svg needs an <svg> element', () => {
  assert.equal(sniffFormat('svg', text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null)
  assert.equal(sniffFormat('svg', text('<SVG viewBox="0 0 1 1">')), null)
  assert.match(sniffFormat('svg', text('<html><body>not an image</body></html>')) ?? '', /no <svg>/)
  assert.match(sniffFormat('svg', text('<svgfoo>')) ?? '', /no <svg>/)
})

const result: ArtifactToolResult = {
  triage: 'artifact',
  action: 'created',
  id: 'abc',
  title: 'Q3 report',
  format: 'html',
  version: 1,
  size: 1234,
  history: true,
  path: 'files/q3-report-abc12345.html',
  abs: '/tmp/x/files/q3-report-abc12345.html',
}

test('parseArtifactResult: the one-line JSON round-trips', () => {
  assert.deepEqual(parseArtifactResult(JSON.stringify(result)), result)
  const withHint = { ...result, action: 'unchanged' as const, hint: 'no new version: identical content' }
  assert.deepEqual(parseArtifactResult(JSON.stringify(withHint)), withHint)
})

test('parseArtifactResult: text, a wrong discriminator and missing fields are refused', () => {
  assert.equal(parseArtifactResult('ok: created abc at notes/x.md'), null)
  assert.equal(parseArtifactResult('{not json'), null)
  assert.equal(parseArtifactResult('[]'), null)
  assert.equal(parseArtifactResult(JSON.stringify({ ...result, triage: 'other' })), null)
  assert.equal(parseArtifactResult(JSON.stringify({ ...result, action: 'deleted' })), null)
  assert.equal(parseArtifactResult(JSON.stringify({ ...result, format: 'exe' })), null)
  assert.equal(parseArtifactResult(JSON.stringify({ ...result, id: '' })), null)
  assert.equal(parseArtifactResult(JSON.stringify({ ...result, version: '1' })), null)
  const { abs: _abs, ...noAbs } = result
  assert.equal(parseArtifactResult(JSON.stringify(noAbs)), null)
})

test('parseCsv: header, rows, quotes and escaped quotes', () => {
  const r = parseCsv('name,note\n"Ada, L.","said ""hi"""\nBob,plain\n')
  assert.deepEqual(r.header, ['name', 'note'])
  assert.deepEqual(r.rows, [
    ['Ada, L.', 'said "hi"'],
    ['Bob', 'plain'],
  ])
  assert.equal(r.totalRows, 2)
  assert.equal(r.truncated, false)
})

test('parseCsv: CRLF, a quoted newline, a BOM, blank lines and ragged rows', () => {
  const r = parseCsv('﻿a,b,c\r\n1,"two\nlines",3\r\n\r\n4,5\r\n6,7,8,9')
  assert.deepEqual(r.header, ['a', 'b', 'c'])
  assert.deepEqual(r.rows, [['1', 'two\nlines', '3'], ['4', '5'], ['6', '7', '8', '9']])
  assert.equal(r.totalRows, 3)
})

test('parseCsv: the delimiter is sniffed from the first line', () => {
  assert.deepEqual(parseCsv('a;b;c\n1;2;3').rows, [['1', '2', '3']])
  assert.deepEqual(parseCsv('a\tb\n1\t2').rows, [['1', '2']])
  // a comma inside quotes does not decide it
  assert.deepEqual(parseCsv('"a,b,c";d\n1;2').header, ['a,b,c', 'd'])
  assert.deepEqual(parseCsv('a,b;c\n1,2;3').header, ['a', 'b;c'])
})

test('parseCsv: only maxCols cells of a row are kept, totalCols is the widest row', () => {
  const wide = parseCsv(','.repeat(50_000) + '\n' + ','.repeat(10))
  assert.equal(wide.header.length, 200)
  assert.equal(wide.rows[0].length, 11)
  assert.equal(wide.totalCols, 50_001)
  const few = parseCsv('a,b,c,d,e\n1,2,3,4,5', 500, 3)
  assert.deepEqual(few.header, ['a', 'b', 'c'])
  assert.deepEqual(few.rows, [['1', '2', '3']])
  assert.equal(few.totalCols, 5)
  assert.equal(parseCsv('a,b\n1,2').totalCols, 2)
  assert.equal(parseCsv('').totalCols, 0)
})

test('parseCsv: only maxRows rows are kept, totalRows counts them all', () => {
  const lines = ['id,v']
  for (let i = 0; i < 1200; i++) lines.push(`${i},${i * 2}`)
  const r = parseCsv(lines.join('\n'))
  assert.equal(r.rows.length, 500)
  assert.equal(r.totalRows, 1200)
  assert.equal(r.truncated, true)
  assert.deepEqual(r.rows[499], ['499', '998'])
  const small = parseCsv(lines.join('\n'), 5)
  assert.equal(small.rows.length, 5)
  assert.equal(small.totalRows, 1200)
  assert.deepEqual(parseCsv('').header, [])
  assert.equal(parseCsv('only,header').totalRows, 0)
})
