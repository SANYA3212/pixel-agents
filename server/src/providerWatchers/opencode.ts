/**
 * OpenCode (CLI, TUI and OpenCode Desktop share one store):
 *   ~/.local/share/opencode/opencode.db   (SQLite, WAL; $XDG_DATA_HOME honoured)
 *
 * Verified against the real database (schema + row shapes, read-only):
 *  - OpenCode 2.x: `session_v2` (id, directory, title, parent_id, time_archived)
 *    and `session_message` (session_id, type, seq, time_created, time_updated,
 *    data). Message types: user, assistant, idle (turn over), system,
 *    synthetic, compaction, model-switched, agent-switched. An assistant
 *    message's data.content holds {type:"tool", id, name, state:{status, input}}
 *    items; data.time.completed / data.finish ("tool-calls" = another step follows).
 *  - OpenCode 1.x: `session` / `message` (data.role, data.time.completed,
 *    data.finish) / `part` (data {type:"tool", callID, tool, state}).
 *
 * Cost control: `PRAGMA data_version` changes only when ANOTHER connection
 * committed, so an idle database costs one pragma per poll. On change, sessions
 * with messages created inside the adoption window are discovered through the
 * time_created index, and only each session's newest message is read.
 */

import type { DatabaseSync } from 'node:sqlite';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PROVIDER_WATCH_ACTIVE_WINDOW_MS,
  PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
} from '../constants.js';
import { loadSqlite, openReadOnly, reportSqliteUnavailable } from './sqlite.js';
import { describeTool, parseToolArgs } from './toolLabels.js';
import type {
  ParsedSessionState,
  ProviderWatcher,
  WatchedSessionSnapshot,
  WatchedTool,
} from './types.js';

const RUNNING_TOOL_STATUSES = new Set(['pending', 'running']);
/** Bookkeeping message types that say nothing about whether a turn runs. */
const IGNORED_V2_TYPES = ['system', 'synthetic', 'model-switched', 'agent-switched'];

type Row = Record<string, unknown>;

function parseData(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolOf(id: string, rawName: unknown, toolState: unknown): WatchedTool | undefined {
  const st = (toolState ?? {}) as Record<string, unknown>;
  if (!RUNNING_TOOL_STATUSES.has(String(st.status))) return undefined;
  const name = typeof rawName === 'string' ? rawName : 'tool';
  const args = parseToolArgs(st.input);
  if (name === 'skill' && typeof args.name === 'string') {
    return { id, name, status: `Using skill ${args.name}` };
  }
  if (name === 'execute') return { id, name: 'Bash', status: 'Running code' };
  return { id, ...describeTool(name, args) };
}

/** Turn state from OpenCode 2.x's newest meaningful session_message. */
export function openCodeV2State(
  type: string,
  data: Record<string, unknown>,
): Omit<ParsedSessionState, 'sessionId' | 'cwd'> {
  switch (type) {
    case 'idle':
      return { state: 'waiting', tools: [] };
    case 'user':
    case 'compaction':
      return { state: 'active', tools: [] };
    case 'assistant': {
      const tools: WatchedTool[] = [];
      const content = Array.isArray(data.content) ? (data.content as Row[]) : [];
      content.forEach((c, i) => {
        if (c?.type !== 'tool') return;
        const t = toolOf(typeof c.id === 'string' ? c.id : `t${i}`, c.name, c.state);
        if (t) tools.push(t);
      });
      const time = (data.time ?? {}) as Record<string, unknown>;
      const inProgress = time.completed === undefined || time.completed === null;
      if (tools.length > 0 || inProgress || data.finish === 'tool-calls') {
        return { state: 'active', tools };
      }
      return { state: 'waiting', tools: [] };
    }
    default:
      return { state: 'waiting', tools: [] };
  }
}

/** Turn state from OpenCode 1.x's newest message + its parts. */
export function openCodeV1State(
  message: Record<string, unknown>,
  parts: Record<string, unknown>[],
): Omit<ParsedSessionState, 'sessionId' | 'cwd'> {
  if (message.role === 'user') return { state: 'active', tools: [] };
  if (message.role !== 'assistant') return { state: 'waiting', tools: [] };
  const tools: WatchedTool[] = [];
  parts.forEach((p, i) => {
    if (p?.type !== 'tool') return;
    const t = toolOf(typeof p.callID === 'string' ? p.callID : `p${i}`, p.tool, p.state);
    if (t) tools.push(t);
  });
  const time = (message.time ?? {}) as Record<string, unknown>;
  const inProgress = time.completed === undefined || time.completed === null;
  if (tools.length > 0 || inProgress || message.finish === 'tool-calls') {
    return { state: 'active', tools };
  }
  return { state: 'waiting', tools: [] };
}

interface CachedSession {
  key: string;
  snapshot: WatchedSessionSnapshot;
}

export class OpenCodeWatcher implements ProviderWatcher {
  readonly providerId = 'opencode' as const;
  private db: DatabaseSync | null = null;
  private hasV1 = false;
  private hasV2 = false;
  private lastDataVersion: number | undefined;
  private lastFull = Number.NEGATIVE_INFINITY;
  private lastOpenAttempt = Number.NEGATIVE_INFINITY;
  private openFailedReported = false;
  private readonly sessions = new Map<string, CachedSession>();

  constructor(private readonly dbPath: string) {}

  poll(now: number): WatchedSessionSnapshot[] {
    if (!this.ensureOpen(now)) return [];
    const db = this.db as DatabaseSync;
    let dataVersion: number | undefined;
    try {
      const row = db.prepare('PRAGMA data_version').get() as Row | undefined;
      dataVersion = typeof row?.data_version === 'number' ? row.data_version : undefined;
    } catch {
      this.close();
      return [...this.sessions.values()].map((s) => s.snapshot);
    }
    const full = now - this.lastFull >= PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS;
    if (full || dataVersion !== this.lastDataVersion) {
      this.lastDataVersion = dataVersion;
      if (full) this.lastFull = now;
      try {
        if (this.hasV2) this.refreshV2(db, now);
        if (this.hasV1) this.refreshV1(db, now);
      } catch {
        // Locked or mid-migration: keep the last snapshots, retry next poll.
      }
    }
    for (const [id, s] of this.sessions) {
      if (now - s.snapshot.lastActivity > PROVIDER_WATCH_REMOVE_AFTER_MS) this.sessions.delete(id);
    }
    return [...this.sessions.values()].map((s) => s.snapshot);
  }

  dispose(): void {
    this.close();
    this.sessions.clear();
  }

  private close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }

  private ensureOpen(now: number): boolean {
    if (this.db) return true;
    if (now - this.lastOpenAttempt < PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS) return false;
    this.lastOpenAttempt = now;
    if (!fs.existsSync(this.dbPath)) return false;
    if (!loadSqlite()) {
      reportSqliteUnavailable(this.providerId);
      return false;
    }
    const db = openReadOnly(this.dbPath);
    if (!db) {
      if (!this.openFailedReported) {
        this.openFailedReported = true;
        console.log(
          `[Pixel Agents] Provider watchers: could not open ${this.dbPath} read-only; will retry.`,
        );
      }
      return false;
    }
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Row[]).map(
          (r) => String(r.name),
        ),
      );
      this.hasV2 = tables.has('session_v2') && tables.has('session_message');
      this.hasV1 = tables.has('session') && tables.has('message') && tables.has('part');
    } catch {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      return false;
    }
    this.db = db;
    this.lastDataVersion = undefined;
    return true;
  }

  private snapshotFrom(
    id: string,
    meta: Row | undefined,
    parsed: Omit<ParsedSessionState, 'sessionId' | 'cwd'>,
    lastActivity: number,
  ): WatchedSessionSnapshot {
    const directory = typeof meta?.directory === 'string' ? meta.directory : undefined;
    const archived = meta?.time_archived !== undefined && meta?.time_archived !== null;
    return {
      ...parsed,
      providerId: this.providerId,
      sessionId: id,
      cwd: directory,
      title: typeof meta?.title === 'string' ? meta.title : undefined,
      labelDetail: meta?.parent_id ? 'subagent' : undefined,
      state: archived || !meta ? 'ended' : parsed.state,
      tools: archived ? [] : parsed.tools,
      sourcePath: this.dbPath,
      lastActivity,
    };
  }

  private refreshV2(db: DatabaseSync, now: number): void {
    const since = now - PROVIDER_WATCH_ACTIVE_WINDOW_MS;
    const ids = new Set<string>(
      (
        db
          .prepare('SELECT DISTINCT session_id AS id FROM session_message WHERE time_created > ?')
          .all(since) as Row[]
      ).map((r) => String(r.id)),
    );
    for (const id of this.sessions.keys()) if (id.startsWith('v2:')) ids.add(id.slice(3));
    const latestStmt = db.prepare(
      `SELECT id, type, time_updated, data FROM session_message
       WHERE session_id = ? AND type NOT IN (${IGNORED_V2_TYPES.map(() => '?').join(',')})
       ORDER BY seq DESC LIMIT 1`,
    );
    const metaStmt = db.prepare(
      'SELECT directory, title, parent_id, time_archived, time_updated FROM session_v2 WHERE id = ?',
    );
    for (const id of ids) {
      const latest = latestStmt.get(id, ...IGNORED_V2_TYPES) as Row | undefined;
      if (!latest) continue;
      const updated = Number(latest.time_updated) || 0;
      const meta = metaStmt.get(id) as Row | undefined;
      const key = `${String(latest.id)}:${updated}:${String(meta?.time_archived ?? '')}`;
      const cacheKey = `v2:${id}`;
      if (this.sessions.get(cacheKey)?.key === key) continue;
      const parsed = openCodeV2State(String(latest.type), parseData(latest.data));
      const lastActivity = Math.max(updated, Number(meta?.time_updated) || 0);
      this.sessions.set(cacheKey, {
        key,
        snapshot: this.snapshotFrom(id, meta, parsed, lastActivity),
      });
    }
  }

  private refreshV1(db: DatabaseSync, now: number): void {
    const since = now - PROVIDER_WATCH_ACTIVE_WINDOW_MS;
    const ids = new Set<string>(
      (db.prepare('SELECT id FROM session WHERE time_updated > ?').all(since) as Row[]).map((r) =>
        String(r.id),
      ),
    );
    for (const id of this.sessions.keys()) if (id.startsWith('v1:')) ids.add(id.slice(3));
    const latestStmt = db.prepare(
      'SELECT id, time_updated, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1',
    );
    const partsStmt = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY id');
    const metaStmt = db.prepare(
      'SELECT directory, title, parent_id, time_archived, time_updated FROM session WHERE id = ?',
    );
    for (const id of ids) {
      const latest = latestStmt.get(id) as Row | undefined;
      if (!latest) continue;
      const updated = Number(latest.time_updated) || 0;
      const meta = metaStmt.get(id) as Row | undefined;
      const key = `${String(latest.id)}:${updated}:${String(meta?.time_archived ?? '')}`;
      const cacheKey = `v1:${id}`;
      if (this.sessions.get(cacheKey)?.key === key) continue;
      const parts = (partsStmt.all(String(latest.id)) as Row[]).map((p) => parseData(p.data));
      const parsed = openCodeV1State(parseData(latest.data), parts);
      const lastActivity = Math.max(updated, Number(meta?.time_updated) || 0);
      this.sessions.set(cacheKey, {
        key,
        snapshot: this.snapshotFrom(id, meta, parsed, lastActivity),
      });
    }
  }
}

export function openCodeDbPath(home = os.homedir()): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

export function createOpenCodeWatcher(home = os.homedir()): OpenCodeWatcher {
  return new OpenCodeWatcher(openCodeDbPath(home));
}
