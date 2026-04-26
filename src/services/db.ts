import pg from 'pg';

// ---------------------------------------------------------------------------
// Postgres connection pool + small helpers.
//
// Replaces `supabaseAdmin.from(...)` across the codebase. Connection string
// comes from DATABASE_URL. For the existing Supabase-hosted Postgres, that's
// the pooler URL (port 5432, user `postgres.<projectref>`). For self-hosted
// it's whatever postgres://user:pass@host:port/db is in front of you.
//
// We intentionally don't rebuild supabase-js's chainable API — the calls
// it replaces become raw SQL via `selectOne` / `selectMany` / `insertOne` /
// `updateOne` / `upsertOne`. A few rare cases use `db.query` directly.
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL env var is required');
  }
  _pool = new pg.Pool({
    connectionString,
    // Supabase's pooler requires SSL; self-hosters can override with
    // ?sslmode=disable in their connection string. The library reads the
    // sslmode query param when ssl is `false`, otherwise we default to
    // accept-any-cert which works for both the pooler and local dev.
    ssl: connectionString.includes('sslmode=disable')
      ? false
      : { rejectUnauthorized: false },
    max: 10,
  });
  return _pool;
}

/// Raw query escape hatch. Prefer the typed helpers below.
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/// Run a query and return the first row, or null if no rows.
export async function selectOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const { rows } = await query<pg.QueryResultRow>(text, params);
  return (rows[0] as T | undefined) ?? null;
}

/// Run a query and return all rows as a typed array.
export async function selectMany<T>(text: string, params?: unknown[]): Promise<T[]> {
  const { rows } = await query<pg.QueryResultRow>(text, params);
  return rows as T[];
}

// ---------------------------------------------------------------------------
// Insert / update / upsert helpers.
// These take a record object and build the SQL automatically. Column names
// must match the table — caller is responsible for that. Returns the
// inserted/updated row (RETURNING *).
// ---------------------------------------------------------------------------

/// Insert one row. Returns the inserted row.
export async function insertOne<T>(table: string, record: Record<string, unknown>): Promise<T> {
  const cols = Object.keys(record);
  const vals = Object.values(record);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`;
  const { rows } = await query<pg.QueryResultRow>(text, vals);
  return rows[0] as T;
}

/// Update rows matching `where`, set `patch`, return updated row(s).
/// where is { col: val, ... } — combined with AND. patch is the SET clause.
export async function updateOne<T>(
  table: string,
  patch: Record<string, unknown>,
  where: Record<string, unknown>
): Promise<T | null> {
  const patchCols = Object.keys(patch);
  const whereCols = Object.keys(where);
  if (patchCols.length === 0) throw new Error(`updateOne: empty patch on ${table}`);
  if (whereCols.length === 0) throw new Error(`updateOne: empty where on ${table}`);

  const setClause = patchCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
  const whereClause = whereCols
    .map((c, i) => `${c} = $${patchCols.length + i + 1}`)
    .join(' AND ');
  const text = `UPDATE ${table} SET ${setClause} WHERE ${whereClause} RETURNING *`;
  const params = [...Object.values(patch), ...Object.values(where)];
  const { rows } = await query<pg.QueryResultRow>(text, params);
  return (rows[0] as T | undefined) ?? null;
}

export interface UpsertOptions {
  /// Comma-separated list of conflict-target columns ("user_id,book_id").
  onConflict: string;
  /// If true, ON CONFLICT DO NOTHING (skip dupes silently).
  /// If false (default), ON CONFLICT DO UPDATE SET <all-non-conflict-cols>.
  ignoreDuplicates?: boolean;
}

/// Upsert one row. By default updates on conflict (overwriting); pass
/// `ignoreDuplicates: true` for INSERT ... DO NOTHING semantics.
export async function upsertOne<T>(
  table: string,
  record: Record<string, unknown>,
  opts: UpsertOptions
): Promise<T | null> {
  const cols = Object.keys(record);
  const vals = Object.values(record);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const conflictTarget = opts.onConflict;

  let conflictAction: string;
  if (opts.ignoreDuplicates) {
    conflictAction = 'DO NOTHING';
  } else {
    const conflictKeys = new Set(conflictTarget.split(',').map((s) => s.trim()));
    const updateCols = cols.filter((c) => !conflictKeys.has(c));
    if (updateCols.length === 0) {
      conflictAction = 'DO NOTHING';
    } else {
      const setExpr = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      conflictAction = `DO UPDATE SET ${setExpr}`;
    }
  }

  const text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflictTarget}) ${conflictAction} RETURNING *`;
  const { rows } = await query<pg.QueryResultRow>(text, vals);
  return (rows[0] as T | undefined) ?? null;
}

/// Bulk upsert. Same semantics as upsertOne but for many rows. Returns the
/// number of rows actually inserted (skipped duplicates not counted).
export async function upsertMany(
  table: string,
  records: Record<string, unknown>[],
  opts: UpsertOptions
): Promise<number> {
  if (records.length === 0) return 0;
  const cols = Object.keys(records[0]);
  const params: unknown[] = [];
  const valueRows: string[] = [];
  for (const r of records) {
    const placeholders = cols.map((c) => {
      params.push(r[c]);
      return `$${params.length}`;
    });
    valueRows.push(`(${placeholders.join(', ')})`);
  }

  let conflictAction: string;
  if (opts.ignoreDuplicates) {
    conflictAction = 'DO NOTHING';
  } else {
    const conflictKeys = new Set(opts.onConflict.split(',').map((s) => s.trim()));
    const updateCols = cols.filter((c) => !conflictKeys.has(c));
    if (updateCols.length === 0) {
      conflictAction = 'DO NOTHING';
    } else {
      const setExpr = updateCols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
      conflictAction = `DO UPDATE SET ${setExpr}`;
    }
  }

  const text = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${valueRows.join(', ')} ON CONFLICT (${opts.onConflict}) ${conflictAction}`;
  const result = await query(text, params);
  return result.rowCount ?? 0;
}

/// Delete rows matching the where clause. Returns the number deleted.
export async function deleteWhere(
  table: string,
  where: Record<string, unknown>
): Promise<number> {
  const cols = Object.keys(where);
  if (cols.length === 0) throw new Error(`deleteWhere: empty where on ${table}`);
  const whereClause = cols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
  const text = `DELETE FROM ${table} WHERE ${whereClause}`;
  const result = await query(text, Object.values(where));
  return result.rowCount ?? 0;
}
