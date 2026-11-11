// Development only: run the real Worker handler against a local SQLite database.
// This adapter is never included in the production Functions bundle.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function createLocalD1(path) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.exec(readFileSync(new URL('../migrations/0001_play_saves.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first(column) {
          const row = database.prepare(sql).get(...params) ?? null;
          return column ? row?.[column] ?? null : row;
        },
        async run() { return this.executeSync(); },
        async all() { return this.executeSync(); },
        executeSync() {
          const statement = database.prepare(sql);
          if (statement.columns().length) return { success: true, results: statement.all(...params), meta: { changes: 0 } };
          const result = statement.run(...params);
          return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    },
    async batch(statements) {
      // Keep the transaction synchronous: another HTTP request must not interleave BEGIN/COMMIT.
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.executeSync());
        database.exec('COMMIT');
        return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    close() { database.close(); },
  };
}
