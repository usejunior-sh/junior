import { useMemo, useState } from 'react'
import { parseCsv } from '../../../../shared/csv.js'

const ROWS = 500
const COLS = 200
/** The raw view is one `<pre>`: a few hundred KB is as much as it should be asked to lay out. */
const RAW_CHARS = 200_000

/**
 * A csv artifact as a table: sticky header, a row-number gutter, the first 500
 * rows. Raw shows the text as it is. `cut` says the server already cut the
 * text (a file over the inline cap), so the row count is of what we have.
 */
export function CsvView({ text, cut }: { text: string; cut: boolean }) {
  const [raw, setRaw] = useState(false)
  const parsed = useMemo(() => parseCsv(text, ROWS, COLS), [text])
  // parseCsv keeps at most COLS cells a row; the rest are counted, not drawn
  const cols = Math.min(COLS, parsed.totalCols)
  const hidden = parsed.totalCols - cols

  return (
    <div className="artCsvView">
      <div className="artViewBar">
        <span className="artCsvInfo">
          {parsed.truncated ? `Showing ${ROWS} of ${parsed.totalRows.toLocaleString()} rows` : `${parsed.totalRows.toLocaleString()} ${parsed.totalRows === 1 ? 'row' : 'rows'}`}
          {parsed.totalCols > 0 && ` · ${parsed.totalCols.toLocaleString()} ${parsed.totalCols === 1 ? 'column' : 'columns'}`}
          {hidden > 0 && ` (showing ${cols}, +${hidden.toLocaleString()} not shown)`}
          {cut && ' · the file is large, so this is the start of it'}
        </span>
        <div className="seg" role="group" aria-label="View">
          <button type="button" className={`segBtn${raw ? '' : ' active'}`} aria-pressed={!raw} onClick={() => setRaw(false)}>
            Table
          </button>
          <button type="button" className={`segBtn${raw ? ' active' : ''}`} aria-pressed={raw} onClick={() => setRaw(true)}>
            Raw
          </button>
        </div>
      </div>
      {raw ? (
        <pre className="artCode artCsvRaw">
          {text.slice(0, RAW_CHARS)}
          {text.length > RAW_CHARS && '\n… the rest is in the file.'}
        </pre>
      ) : cols === 0 ? (
        <div className="artEmpty artViewEmpty">Empty file.</div>
      ) : (
        <div className="artCsvScroll">
          <table className="artCsvTable">
            <thead>
              <tr>
                <th className="gut" scope="col" aria-label="Row" />
                {Array.from({ length: cols }, (_, c) => (
                  <th key={c} scope="col" title={parsed.header[c]}>
                    {parsed.header[c] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r, i) => (
                <tr key={i}>
                  <td className="gut">{i + 1}</td>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} title={r[c]}>
                      {r[c] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
