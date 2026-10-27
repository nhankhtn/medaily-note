import Database from '@tauri-apps/plugin-sql'

const DB_URL = 'sqlite:notes.db'
const LEGACY_KEY = 'medaily.quicknote.localNotes'
const LOCAL_PAGE = 20

export type LocalNote = {
  id: string
  title: string
  bodyMd: string
  updatedAt: string
}

export type NotesCursor = { updatedAt: string; id: string }

type NoteRow = {
  id: string
  title: string
  body_md: string
  updated_at: string
}

let dbPromise: Promise<Database> | null = null

function mapRow(row: NoteRow): LocalNote {
  return {
    id: row.id,
    title: row.title ?? '',
    bodyMd: row.body_md,
    updatedAt: row.updated_at,
  }
}

async function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL).then(async (db) => {
      await migrateLegacyLocalStorage(db)
      return db
    })
  }
  return dbPromise
}

function readLegacyNotes(): LocalNote[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const note = row as Partial<LocalNote>
      if (
        typeof note.id !== 'string' ||
        typeof note.bodyMd !== 'string' ||
        typeof note.updatedAt !== 'string'
      ) {
        return []
      }
      return [
        {
          id: note.id,
          title: typeof note.title === 'string' ? note.title : '',
          bodyMd: note.bodyMd,
          updatedAt: note.updatedAt,
        },
      ]
    })
  } catch {
    return []
  }
}

async function migrateLegacyLocalStorage(db: Database) {
  const legacy = readLegacyNotes()
  if (legacy.length === 0) return

  for (const note of legacy) {
    await db.execute(
      `INSERT INTO local_notes (id, title, body_md, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         body_md = excluded.body_md,
         updated_at = excluded.updated_at`,
      [note.id, note.title, note.bodyMd, note.updatedAt],
    )
  }
  localStorage.removeItem(LEGACY_KEY)
}

export async function ensureLocalNotesDb(): Promise<void> {
  await getDb()
}

export async function isLocalNoteId(id: string | null | undefined): Promise<boolean> {
  if (!id) return false
  const db = await getDb()
  const rows = await db.select<Array<{ id: string }>>(
    'SELECT id FROM local_notes WHERE id = $1 LIMIT 1',
    [id],
  )
  return rows.length > 0
}

export async function upsertLocalNote(input: {
  id?: string | null
  title: string
  bodyMd: string
}): Promise<LocalNote> {
  const db = await getDb()
  const now = new Date().toISOString()

  if (input.id) {
    const existing = await db.select<NoteRow[]>(
      'SELECT id, title, body_md, updated_at FROM local_notes WHERE id = $1 LIMIT 1',
      [input.id],
    )
    if (existing[0]) {
      await db.execute(
        `UPDATE local_notes
         SET title = $1, body_md = $2, updated_at = $3
         WHERE id = $4`,
        [input.title, input.bodyMd, now, input.id],
      )
      return {
        id: input.id,
        title: input.title,
        bodyMd: input.bodyMd,
        updatedAt: now,
      }
    }
  }

  const created: LocalNote = {
    id: crypto.randomUUID(),
    title: input.title,
    bodyMd: input.bodyMd,
    updatedAt: now,
  }
  await db.execute(
    `INSERT INTO local_notes (id, title, body_md, updated_at)
     VALUES ($1, $2, $3, $4)`,
    [created.id, created.title, created.bodyMd, created.updatedAt],
  )
  return created
}

export async function localNotesPage(opts: {
  q: string
  cursor?: NotesCursor | null
  limit?: number
}): Promise<{ entries: LocalNote[]; nextCursor: NotesCursor | null }> {
  const db = await getDb()
  const limit = opts.limit ?? LOCAL_PAGE
  const q = opts.q.trim().replace(/[%_\\]/g, '\\$&')
  const cursorAt = opts.cursor?.updatedAt ?? ''
  const cursorId = opts.cursor?.id ?? ''

  const rows = await db.select<NoteRow[]>(
    `SELECT id, title, body_md, updated_at
     FROM local_notes
     WHERE (
       $1 = ''
       OR title LIKE '%' || $1 || '%' ESCAPE '\\' COLLATE NOCASE
       OR body_md LIKE '%' || $1 || '%' ESCAPE '\\' COLLATE NOCASE
     )
     AND (
       $2 = ''
       OR updated_at < $2
       OR (updated_at = $2 AND id < $3)
     )
     ORDER BY updated_at DESC, id DESC
     LIMIT $4`,
    [q, cursorAt, cursorId, limit + 1],
  )

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.length > 0 ? page[page.length - 1] : undefined
  return {
    entries: page.map(mapRow),
    nextCursor:
      hasMore && last ? { updatedAt: last.updated_at, id: last.id } : null,
  }
}

export { LOCAL_PAGE }
