import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A small D1 stand-in over better-sqlite3 so store and service tests run the
// real migrations in plain Node. It covers the D1 calls the control plane uses.

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.db, this.sql, params);
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (statement.reader) return { results: statement.all(...this.params), meta: { changes: 0 } };
    const info = statement.run(...this.params);
    return { results: [], meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
  }

  async all() {
    return this.execute();
  }

  async first(column) {
    const row = this.db.prepare(this.sql).get(...this.params) ?? null;
    return column && row ? row[column] : row;
  }

  async run() {
    return this.execute();
  }
}

export const migrationFiles = () => readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
export const applyMigration = (raw, file) => raw.exec(readFileSync(`${MIGRATIONS}${file}`, "utf8"));

// `before` stops at that migration, to test data written by older versions.
export function createTestD1({ before = null } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of migrationFiles()) {
    if (before && file >= before) break;
    applyMigration(db, file);
  }
  return {
    raw: db,
    prepare: (sql) => new Statement(db, sql),
    batch: async (statements) => db.transaction(() => statements.map((statement) => statement.execute()))(),
    exec: async (sql) => db.exec(sql),
  };
}
