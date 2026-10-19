/**
 * A small CSV reader for previews: RFC-4180-ish, no dependency, browser-safe.
 * Quoted fields, `""` escapes, CRLF or LF, and a delimiter sniffed from the
 * first line (`,` `;` or tab). The first row is the header. Rows may be ragged.
 * Only `maxRows` data rows are kept, `totalRows` counts them all (the header is not a row).
 * Only the first `maxCols` cells of a row are kept, `totalCols` is the widest row's width.
 */

export type ParsedCsv = { header: string[]; rows: string[][]; totalRows: number; truncated: boolean; totalCols: number }

/** The delimiter that splits the first line into the most cells, outside quotes. */
function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') inQuotes = !inQuotes
    else if (!inQuotes && (c === '\n' || c === '\r')) break
    else if (!inQuotes && c in counts) counts[c]++
  }
  let best = ','
  for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d
  return best
}

export function parseCsv(text: string, maxRows = 500, maxCols = 200): ParsedCsv {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delim = sniffDelimiter(src)
  const records: string[][] = []
  let kept = 0
  let total = 0
  let row: string[] = []
  let cell = ''
  let cells = 0 // cells in the current record, kept or not
  let totalCols = 0
  let inQuotes = false
  let any = false // the current record has content (a blank line is not a row)

  const pushCell = () => {
    cells++
    if (row.length < maxCols) row.push(cell)
    cell = ''
  }

  const endRecord = () => {
    pushCell()
    // the header is row 0 and is always kept; data rows stop at maxRows
    if (any || cells > 1) {
      totalCols = Math.max(totalCols, cells)
      if (total === 0 || kept < maxRows) {
        records.push(row)
        if (total > 0) kept++
      }
      total++
    }
    row = []
    cells = 0
    any = false
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else inQuotes = false
      } else cell += c
      continue
    }
    if (c === '"' && cell === '') {
      inQuotes = true
      any = true
    } else if (c === delim) {
      pushCell()
      any = true
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      endRecord()
    } else {
      cell += c
      any = true
    }
  }
  if (any || cell !== '' || cells) endRecord()

  const [header = [], ...rows] = records
  const totalRows = Math.max(0, total - 1)
  return { header, rows, totalRows, truncated: totalRows > rows.length, totalCols }
}
