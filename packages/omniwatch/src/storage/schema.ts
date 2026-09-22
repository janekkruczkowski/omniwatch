/**
 * Versioned SQLite schema and migrations (T2 / D3).
 *
 * The store keeps operational state and references only. It is not a knowledge
 * library: no embeddings, no note search, no copy of the Vault (TECHNICAL
 * "Kontrakty, identyfikatory i ponowienia", D7).
 *
 * Every migration runs inside one transaction, records itself in
 * `schema_migrations` and, when it rewrites or drops data, first copies the
 * current content of the affected tables to `<table>__backup_v<version>`.
 * A migration that fails rolls back completely and surfaces
 * `OmniWatchError("storage_unavailable", ...)`; there is no in-memory fallback.
 */

import { DatabaseSync } from "node:sqlite";

import { OmniWatchError } from "../contracts/errors.ts";

/** Schema version this runtime writes and understands. */
export const SCHEMA_VERSION = 1;

/** Bounded wait for a competing writer before SQLite reports SQLITE_BUSY. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface Migration {
  version: number;
  name: string;
  /**
   * Tables whose current rows must be copied to `<table>__backup_v<version>`
   * inside the migration transaction before the step runs. Required for every
   * step that rewrites or drops data (PLAN D3: "migracje z kopią stanu").
   */
  backupTables?: string[];
  up(db: DatabaseSync): void;
}

export interface AppliedMigration {
  version: number;
  name: string;
  appliedAt: string;
  backupTables: string[];
}

function storageFailure(message: string, cause?: unknown): OmniWatchError {
  return new OmniWatchError("storage_unavailable", message, {
    cause,
    action: {
      label: "sprawdz katalog danych OmniWatch i wolne miejsce na dysku",
      kind: "check_operation",
    },
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  const errcode = (error as { errcode?: number } | null)?.errcode;
  if (errcode === 2067 || errcode === 1555) return true;
  return /UNIQUE constraint failed/i.test(messageOf(error));
}

function isBusy(error: unknown): boolean {
  const errcode = (error as { errcode?: number } | null)?.errcode;
  return (
    errcode === 5 ||
    errcode === 6 ||
    /database is locked|database table is locked/i.test(messageOf(error))
  );
}

/**
 * Opens one SQLite connection with the D3 pragmas: foreign keys ON, WAL on
 * local disk, `synchronous=FULL` and a bounded busy wait.
 */
export function openDatabase(
  path: string,
  options: { busyTimeoutMs?: number } = {},
): DatabaseSync {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (error) {
    throw storageFailure(`nie mozna otworzyc bazy SQLite: ${path}`, error);
  }
  try {
    // The bounded busy wait must be first: switching or reading the WAL header
    // takes a lock, and several processes may open the same data directory at
    // the same moment (T03/T04).
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = FULL;");
  } catch (error) {
    try {
      db.close();
    } catch (closeError: unknown) {
      throw storageFailure(
        `nie mozna ustawic pragm SQLite (${messageOf(error)}); zamkniecie polaczenia tez sie nie powiodlo: ${messageOf(closeError)}`,
        error,
      );
    }
    throw storageFailure(`nie mozna ustawic pragm SQLite: ${messageOf(error)}`, error);
  }
  return db;
}

const SCHEMA_V1 = `
  -- migration ledger ---------------------------------------------------------
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    backup_tables TEXT NOT NULL DEFAULT '[]'
  );

  -- collections and scans ----------------------------------------------------
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    trigger TEXT NOT NULL,
    state TEXT NOT NULL,
    settings_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_state_created ON runs(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_runs_collection ON runs(collection_id, created_at);

  -- analyses ----------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    analysis_key TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL,
    error_class TEXT,
    error_message TEXT,
    -- No foreign key on purpose: one operation is shared by several runs and
    -- outlives any single run (D3 "Pozycje dwoch przebiegow moga wskazywac te
    -- sama operacje").
    run_id TEXT,
    execution_snapshot_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_operations_state_created ON operations(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_operations_run ON operations(run_id);

  CREATE TABLE IF NOT EXISTS run_items (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    source_ref_json TEXT NOT NULL,
    operation_id TEXT NOT NULL REFERENCES operations(id),
    state TEXT NOT NULL,
    title TEXT,
    updated_at TEXT NOT NULL,
    -- The composite primary key is the required unique index on (run_id, ordinal).
    PRIMARY KEY (run_id, ordinal)
  );
  CREATE INDEX IF NOT EXISTS idx_run_items_source ON run_items(run_id, source_id);
  CREATE INDEX IF NOT EXISTS idx_run_items_operation ON run_items(operation_id);

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    part_index INTEGER NOT NULL,
    model TEXT,
    request_summary TEXT,
    response_summary TEXT,
    usage_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_operation ON attempts(operation_id, created_at);

  -- delivery -----------------------------------------------------------------
  -- Per TECHNICAL the deliveries table also carries the content waiting to be
  -- written: one durable row per operation, keyed by operation and analysis id.
  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL,
    state TEXT NOT NULL,
    payload_json TEXT,
    memory_ref_json TEXT,
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_operation ON deliveries(operation_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_analysis ON deliveries(analysis_id);
  CREATE INDEX IF NOT EXISTS idx_deliveries_state_created ON deliveries(state, created_at);

  -- conversations -------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    source_ref_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id TEXT PRIMARY KEY,
    -- No foreign key on purpose: turns are the authoritative conversation
    -- content and stay addressable even when the source binding is written
    -- later by ensureConversation (order of adapter calls is not a contract).
    conversation_id TEXT NOT NULL,
    parent_turn_id TEXT,
    role TEXT NOT NULL,
    mode TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_turns_conversation ON conversation_turns(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_turns_parent ON conversation_turns(conversation_id, parent_turn_id);
  -- "unikalny ... (conversation_id, parent_turn_id)": one assistant answer per
  -- user turn. Scoped to assistant turns because D9 explicitly allows parallel
  -- questions ("Rownolegle pytania do tej samej odpowiedzi sa osobnymi
  -- galeziami"), which a blanket unique index on the pair would forbid.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_parent_answer
    ON conversation_turns(conversation_id, parent_turn_id)
    WHERE role = 'assistant' AND parent_turn_id IS NOT NULL;

  -- single-consumer ownership (D5) -------------------------------------------
  CREATE TABLE IF NOT EXISTS runtime_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    pid INTEGER NOT NULL,
    heartbeat_at TEXT NOT NULL,
    acquired_at TEXT NOT NULL
  );

  -- durable scan reports (D8) -------------------------------------------------
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    state TEXT NOT NULL,
    new_analyses INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    pending_items INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reports_state_created ON reports(state, created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_run ON reports(run_id, created_at);

  -- seen-source index for collection updates ----------------------------------
  -- One row per analysed (collection, source, mode, focus, question, language).
  CREATE TABLE IF NOT EXISTS seen_sources (
    collection_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    focus TEXT NOT NULL,
    question TEXT NOT NULL,
    language TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_seen_sources_identity
    ON seen_sources(collection_id, source_id, mode, focus, question, language);
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_operational_state",
    up(db) {
      db.exec(SCHEMA_V1);
    },
  },
];

function parseBackupTables(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch (error) {
    throw storageFailure(`uszkodzony wpis backup_tables w schema_migrations: ${messageOf(error)}`, error);
  }
}

export function listAppliedMigrations(db: DatabaseSync): AppliedMigration[] {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        backup_tables TEXT NOT NULL DEFAULT '[]'
      );
    `);
    const rows = db
      .prepare(
        "SELECT version, name, applied_at, backup_tables FROM schema_migrations ORDER BY version ASC",
      )
      .all() as Array<{ version: number; name: string; applied_at: string; backup_tables: string }>;
    return rows.map((row) => ({
      version: Number(row.version),
      name: String(row.name),
      appliedAt: String(row.applied_at),
      backupTables: parseBackupTables(row.backup_tables),
    }));
  } catch (error) {
    throw storageFailure(`nie mozna odczytac historii migracji: ${messageOf(error)}`, error);
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row !== undefined;
}

function hasMigrationVersion(db: DatabaseSync, version: number): boolean {
  const row = db
    .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = ? LIMIT 1")
    .get(version) as { applied?: number } | undefined;
  return row !== undefined;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw storageFailure(`niepoprawna nazwa tabeli w migracji: ${value}`);
  }
  return `"${value}"`;
}

/**
 * Copies the current rows of the tables a destructive migration is about to
 * rewrite. Runs inside the migration transaction, so a failed step also rolls
 * the copies back.
 */
function copyStateForMigration(db: DatabaseSync, migration: Migration): string[] {
  const copied: string[] = [];
  for (const table of migration.backupTables ?? []) {
    if (!tableExists(db, table)) continue;
    const backup = `${table}__backup_v${migration.version}`;
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(backup)};`);
    db.exec(`CREATE TABLE ${quoteIdentifier(backup)} AS SELECT * FROM ${quoteIdentifier(table)};`);
    copied.push(backup);
  }
  return copied;
}

export interface MigrationRunResult {
  applied: AppliedMigration[];
  skipped: number[];
  schemaVersion: number;
}

/**
 * Applies every pending migration in version order. Migrations are supplied as
 * an argument so fault-injection tests can run a deliberately failing or
 * destructive step against a real database file.
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: Migration[] = MIGRATIONS,
  options: { now?: () => string } = {},
): MigrationRunResult {
  const now = options.now ?? (() => new Date().toISOString());
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  let target = SCHEMA_VERSION;
  for (const migration of ordered) {
    if (seen.has(migration.version)) {
      throw storageFailure(`zduplikowana migracja o wersji ${migration.version}`);
    }
    seen.add(migration.version);
    target = Math.max(target, migration.version);
  }

  const already = listAppliedMigrations(db);
  const appliedVersions = new Set(already.map((migration) => migration.version));
  const newest = already.length > 0 ? already[already.length - 1].version : 0;
  if (newest > target) {
    throw storageFailure(
      `schemat bazy (wersja ${newest}) jest nowszy niz obslugiwany przez ten runtime (wersja ${target}); uruchom nowsza wersje OmniWatch zamiast migrowac w dol`,
    );
  }

  const applied: AppliedMigration[] = [];
  const skipped: number[] = [];
  for (const migration of ordered) {
    if (appliedVersions.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    const appliedAt = now();
    db.exec("BEGIN IMMEDIATE;");
    let backupTables: string[] = [];
    try {
      // Two processes may start the same migration at once; the loser only
      // learns that inside its own transaction (BEGIN IMMEDIATE serializes
      // them), so re-check before applying the step.
      if (hasMigrationVersion(db, migration.version)) {
        db.exec("COMMIT;");
        skipped.push(migration.version);
        continue;
      }
      backupTables = copyStateForMigration(db, migration);
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at, backup_tables) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, appliedAt, JSON.stringify(backupTables));
      db.exec("COMMIT;");
    } catch (error) {
      let rollbackFailure: unknown;
      try {
        db.exec("ROLLBACK;");
      } catch (rollbackError: unknown) {
        rollbackFailure = rollbackError;
      }
      const detail =
        rollbackFailure === undefined
          ? messageOf(error)
          : `${messageOf(error)} (rollback rowniez sie nie powiodl: ${messageOf(rollbackFailure)})`;
      throw storageFailure(
        `migracja ${migration.version} (${migration.name}) nie powiodla sie: ${detail}`,
        error,
      );
    }
    applied.push({ version: migration.version, name: migration.name, appliedAt, backupTables });
  }

  return { applied, skipped, schemaVersion: newest > 0 ? newest : target };
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const applied = listAppliedMigrations(db);
  return applied.length === 0 ? 0 : applied[applied.length - 1].version;
}

/** Schema newer than this runtime must block startup instead of being migrated down. */
export function assertSchemaSupported(db: DatabaseSync, supported: number = SCHEMA_VERSION): number {
  const version = currentSchemaVersion(db);
  if (version > supported) {
    throw storageFailure(
      `schemat bazy ma wersje ${version}, a ten runtime obsluguje do ${supported}; uruchom zgodna wersje OmniWatch`,
    );
  }
  return version;
}

export { isUniqueViolation, isBusy, storageFailure };
