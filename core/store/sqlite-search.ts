/**
 * Local full-text search: one FTS5 index (`search`) over work items, sessions
 * and artifacts. FTS5 ships inside node:sqlite, so this costs no dependency.
 *
 * Items and sessions stay in step through triggers on their own tables, so no
 * write path can forget them. Artifacts are files: the row's title follows by
 * trigger, the body is read off disk by the artifact indexer
 * (server/artifacts.ts) and set with setArtifactBody. A NULL body means "not
 * read yet", which is how the indexer finds the ones to backfill.
 *
 * `search_refs` gives every (kind, ref) a stable integer, used as the FTS
 * rowid, so a trigger finds its row by key instead of scanning the index.
 */
import { DatabaseSync } from 'node:sqlite'
import { isSearchKind, SNIPPET_CLOSE, SNIPPET_OPEN, type SearchHit, type SearchKind } from '../../shared/protocol.js'
import type { SearchOptions, SearchStore } from './types.js'

/**
 * Migration 40 creates these; ensureSearchIndex converges them too, however
 * the version counter got here. No porter stemmer: every query term is a
 * prefix, which a stemmed index breaks ("billin" would miss "billing").
 */
export const SEARCH_TABLES = `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
     kind UNINDEXED, ref, title, body,
     tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3'
   );
   CREATE TABLE IF NOT EXISTS search_refs (
     id   INTEGER PRIMARY KEY,
     kind TEXT NOT NULL,
     ref  TEXT NOT NULL,
     UNIQUE (kind, ref)
   );`

// SQL fragments, shared by the triggers and the rebuild so they cannot drift.

const json = (col: string, p: string) => `(CASE WHEN json_valid(${col}) THEN json_extract(${col}, '${p}') END)`

const itemTitle = (row: string) => `coalesce(${json(`${row}.payload`, '$.title')}, '')`

/** The human's words first, then the scanner's reason (when it says more), the ask, who and where. */
const itemBody = (row: string) => {
  const p = `${row}.payload`
  const desc = `coalesce(${json(p, '$.description')}, ${json(p, '$.note')})`
  const why = json(p, '$.why')
  return `trim(coalesce(${desc}, '')
    || char(10) || CASE WHEN ${why} IS ${desc} THEN '' ELSE coalesce(${why}, '') END
    || char(10) || coalesce(${json(p, '$.ask')}, '')
    || char(10) || coalesce(${json(p, '$.author')}, '') || ' ' || coalesce(${json(p, '$.repo')}, ''), char(10) || ' ')`
}

const rowid = (kind: SearchKind, ref: string) => `(SELECT id FROM search_refs WHERE kind = '${kind}' AND ref = ${ref})`

const put = (kind: SearchKind, ref: string, title: string, body: string) => `
    INSERT OR IGNORE INTO search_refs (kind, ref) VALUES ('${kind}', ${ref});
    DELETE FROM search WHERE rowid = ${rowid(kind, ref)};
    INSERT INTO search (rowid, kind, ref, title, body) VALUES (${rowid(kind, ref)}, '${kind}', ${ref}, ${title}, ${body});`

const drop = (kind: SearchKind, ref: string) => `
    DELETE FROM search WHERE rowid = ${rowid(kind, ref)};
    DELETE FROM search_refs WHERE kind = '${kind}' AND ref = ${ref};`

/** Bump the version in these names when a trigger changes: ensureSearchIndex rebuilds when they are missing. */
const SENTINEL = 'search_v1_item_ai'

export const SEARCH_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS ${SENTINEL} AFTER INSERT ON work_items BEGIN${put('item', 'new.id', itemTitle('new'), itemBody('new'))}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_item_au AFTER UPDATE OF id, payload ON work_items
  WHEN old.id IS NOT new.id OR ${itemTitle('old')} IS NOT ${itemTitle('new')} OR ${itemBody('old')} IS NOT ${itemBody('new')}
  BEGIN${drop('item', 'old.id')}${put('item', 'new.id', itemTitle('new'), itemBody('new'))}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_item_ad AFTER DELETE ON work_items BEGIN${drop('item', 'old.id')}
  END;

  CREATE TRIGGER IF NOT EXISTS search_v1_session_ai AFTER INSERT ON sessions BEGIN${put('session', 'new.id', 'new.title', "coalesce(new.name, '')")}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_session_au AFTER UPDATE OF id, title, name ON sessions
  WHEN old.id IS NOT new.id OR old.title IS NOT new.title OR old.name IS NOT new.name
  BEGIN${drop('session', 'old.id')}${put('session', 'new.id', 'new.title', "coalesce(new.name, '')")}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_session_ad AFTER DELETE ON sessions BEGIN${drop('session', 'old.id')}
  END;

  CREATE TRIGGER IF NOT EXISTS search_v1_artifact_ai AFTER INSERT ON artifacts BEGIN${put('artifact', 'new.id', 'new.title', 'NULL')}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_artifact_au_id AFTER UPDATE OF id ON artifacts
  WHEN old.id IS NOT new.id
  BEGIN${drop('artifact', 'old.id')}${put('artifact', 'new.id', 'new.title', 'NULL')}
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_artifact_au_title AFTER UPDATE OF title ON artifacts
  WHEN old.id IS new.id AND old.title IS NOT new.title
  BEGIN
    UPDATE search SET title = new.title WHERE rowid = ${rowid('artifact', 'new.id')};
  END;
  CREATE TRIGGER IF NOT EXISTS search_v1_artifact_ad AFTER DELETE ON artifacts BEGIN${drop('artifact', 'old.id')}
  END;`

/** Refill the index from the rows. Artifact bodies come back as NULL, for the artifact indexer to read again. */
export const SEARCH_REBUILD = `
  DELETE FROM search;
  DELETE FROM search_refs;
  INSERT INTO search_refs (kind, ref) SELECT 'item', id FROM work_items;
  INSERT INTO search_refs (kind, ref) SELECT 'session', id FROM sessions;
  INSERT INTO search_refs (kind, ref) SELECT 'artifact', id FROM artifacts;
  INSERT INTO search (rowid, kind, ref, title, body)
    SELECT r.id, 'item', w.id, ${itemTitle('w')}, ${itemBody('w')} FROM work_items w JOIN search_refs r ON r.kind = 'item' AND r.ref = w.id;
  INSERT INTO search (rowid, kind, ref, title, body)
    SELECT r.id, 'session', s.id, s.title, coalesce(s.name, '') FROM sessions s JOIN search_refs r ON r.kind = 'session' AND r.ref = s.id;
  INSERT INTO search (rowid, kind, ref, title, body)
    SELECT r.id, 'artifact', a.id, a.title, NULL FROM artifacts a JOIN search_refs r ON r.kind = 'artifact' AND r.ref = a.id;`

const hasTrigger = (db: DatabaseSync, name: string): boolean =>
  db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(name) !== undefined

/** Rebuild the whole index from the rows, in one transaction. */
export function rebuildSearchIndex(db: DatabaseSync): void {
  db.exec('BEGIN')
  try {
    db.exec(SEARCH_REBUILD)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * Converge the index after the tables it follows exist: create what is
 * missing, and rebuild from the rows the first time the triggers go in (a DB
 * from before search, or after a trigger change bumped the names).
 */
export function ensureSearchIndex(db: DatabaseSync): void {
  if (hasTrigger(db, SENTINEL)) {
    db.exec(SEARCH_TABLES)
    return
  }
  db.exec('BEGIN')
  try {
    db.exec(SEARCH_TABLES)
    db.exec(SEARCH_TRIGGERS)
    db.exec(SEARCH_REBUILD)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/**
 * What a person typed → an FTS5 query. Every word is quoted (so no input is
 * FTS syntax) and a prefix (so it works as you type); words AND together.
 * Null when nothing searchable is left.
 */
export function ftsQuery(q: string): string | null {
  const terms = q
    .normalize('NFKC')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 16)
  return terms.length ? terms.map((t) => `"${t}"*`).join(' ') : null
}

const SEARCH_LIMIT_MAX = 100
/** Long enough for a few lines of context, short enough for a palette row. */
const SNIPPET_TOKENS = 12
/** Artifact bodies are capped: the index is for finding, not for storing the file. */
export const SEARCH_BODY_MAX = 200_000

export class SqliteSearch implements SearchStore {
  constructor(private db: DatabaseSync) {}

  async search(q: string, o: SearchOptions = {}): Promise<SearchHit[]> {
    const match = ftsQuery(q)
    if (!match) return []
    const kinds = (o.kinds ?? []).filter(isSearchKind)
    const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.floor(o.limit ?? 20)))
    const where = kinds.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : ''
    // Title hits outrank body hits; the ref (repo, number) counts a little; kind is not indexed.
    const rows = this.db
      .prepare(
        `SELECT kind, ref, title, snippet(search, -1, ?, ?, '…', ${SNIPPET_TOKENS}) AS snippet
         FROM search WHERE search MATCH ?${where}
         ORDER BY bm25(search, 0.0, 2.0, 10.0, 1.0) LIMIT ?`,
      )
      .all(SNIPPET_OPEN, SNIPPET_CLOSE, match, ...kinds, limit) as { kind: string; ref: string; title: string; snippet: string | null }[]
    return rows.flatMap((r) => (isSearchKind(r.kind) ? [{ kind: r.kind, ref: r.ref, title: r.title, snippet: r.snippet ?? '' }] : []))
  }

  async setArtifactBody(id: string, body: string): Promise<void> {
    this.db.prepare(`UPDATE search SET body = ? WHERE rowid = ${rowid('artifact', '?')}`).run(body.slice(0, SEARCH_BODY_MAX), id)
  }

  async artifactsWithoutBody(): Promise<string[]> {
    const rows = this.db.prepare(`SELECT ref FROM search WHERE kind = 'artifact' AND body IS NULL`).all() as { ref: string }[]
    return rows.map((r) => r.ref)
  }

  async rebuild(): Promise<void> {
    rebuildSearchIndex(this.db)
  }
}
