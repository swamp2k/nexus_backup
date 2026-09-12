import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function openSqliteD1({ filename, migrationsDir }) {
  await mkdir(dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  await applyMigrations(database, migrationsDir);
  return new SqliteD1Database(database);
}

export class SqliteD1Database {
  #database;

  constructor(database) {
    this.#database = database;
  }

  prepare(query) {
    return new SqliteD1PreparedStatement(this.#database, query, []);
  }

  async batch(statements) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteD1PreparedStatement) || statement.database !== this.#database) {
          throw new TypeError("SQLite batch statements must belong to the same database");
        }
        return statement.execute();
      });
      this.#database.exec("COMMIT");
      return results;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  close() {
    this.#database.close();
  }
}

class SqliteD1PreparedStatement {
  database;
  #query;
  #values;

  constructor(database, query, values) {
    this.database = database;
    this.#query = query;
    this.#values = values;
  }

  bind(...values) {
    return new SqliteD1PreparedStatement(this.database, this.#query, values);
  }

  async first(columnName) {
    const row = this.database.prepare(this.#query).get(...this.#values);
    if (row === undefined) return null;
    if (columnName === undefined) return row;
    return row[columnName] ?? null;
  }

  async all() {
    return this.#rowsResult();
  }

  async run() {
    return this.execute();
  }

  execute() {
    if (returnsRows(this.#query)) return this.#rowsResult();
    const result = this.database.prepare(this.#query).run(...this.#values);
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  #rowsResult() {
    const results = this.database.prepare(this.#query).all(...this.#values);
    return { success: true, results };
  }
}

function returnsRows(query) {
  return /\bRETURNING\b/i.test(query) || /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query);
}

async function applyMigrations(database, migrationsDir) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS nexus_backup_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
  const entries = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  for (const name of entries) {
    const existing = database.prepare("SELECT name FROM nexus_backup_migrations WHERE name = ?").get(name);
    if (existing !== undefined) continue;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database.prepare("INSERT INTO nexus_backup_migrations (name, applied_at) VALUES (?, ?)")
        .run(name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw new Error(`Failed to apply migration ${name}`, { cause: error });
    }
  }
}
