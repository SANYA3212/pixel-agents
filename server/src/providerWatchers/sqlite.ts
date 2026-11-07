/**
 * Lazy access to Node's built-in SQLite (`node:sqlite`, Node >= 22.5; unflagged
 * from 22.13 / 23.4). On older runtimes the SQLite-backed watchers (OpenCode,
 * Cursor) disable themselves with ONE log line instead of failing the server.
 * Databases are always opened read-only: we never write another agent's data.
 */

import type { DatabaseSync } from 'node:sqlite';

type SqliteModule = typeof import('node:sqlite');

let cached: SqliteModule | null | undefined;
let reported = false;

/** The node:sqlite module, or null when this Node build has none. */
export function loadSqlite(): SqliteModule | null {
  if (cached !== undefined) return cached;
  try {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod =
      (getBuiltin?.('node:sqlite') as SqliteModule | undefined) ??
      (require('node:sqlite') as SqliteModule);
    cached = mod && typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Log (once per process) that SQLite-backed providers are off. */
export function reportSqliteUnavailable(providerId: string): void {
  if (reported) return;
  reported = true;
  console.log(
    `[Pixel Agents] Provider watchers: node:sqlite unavailable on Node ${process.versions.node}; ` +
      `${providerId} (and other SQLite-backed providers) disabled. Use Node 22.13+ to enable.`,
  );
}

/** Open a database read-only, or null on any error. */
export function openReadOnly(file: string): DatabaseSync | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}
