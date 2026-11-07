/**
 * Cursor agent CLI (`cursor-agent` / `agent`). NOT installed on the dev machine —
 * implemented from reverse-engineered descriptions of its chat store:
 *
 *   ~/.cursor/chats/<md5(workspace)>/<sessionId>/store.db   (SQLite, WAL while live)
 *     meta(key, value): key "0" = agent record (hex-encoded or plain JSON) with
 *       agentId, name, workspacePath, latestRootBlobId, ...
 *     blobs(id, data): content-addressed; JSON blobs are messages
 *       {role: user|assistant|tool, content}; assistant content has
 *       {type:"tool-call", toolCallId, toolName, args}, tool content has
 *       {type:"tool-result", toolCallId}
 *
 * Each store is opened read-only only when its files changed, and closed again.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  PROVIDER_WATCH_ACTIVE_WINDOW_MS,
  PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
} from '../constants.js';
import { DirLister } from './fileSessionWatcher.js';
import { loadSqlite, openReadOnly, reportSqliteUnavailable } from './sqlite.js';
import { describeTool, parseToolArgs } from './toolLabels.js';
import type {
  ParsedSessionState,
  ProviderWatcher,
  WatchedSessionSnapshot,
  WatchedTool,
} from './types.js';

/** Newest blobs examined per read. */
const CURSOR_RECENT_BLOBS = 60;

type Row = Record<string, unknown>;

function bytesToString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');
  return undefined;
}

/** meta values are hex-encoded JSON in some CLI versions, plain JSON in others. */
export function decodeCursorMeta(v: unknown): Record<string, unknown> | undefined {
  let s = bytesToString(v)?.trim();
  if (!s) return undefined;
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) s = Buffer.from(s, 'hex').toString('utf8');
  try {
    const o: unknown = JSON.parse(s);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the JSON message blobs (others are protobuf turn state). */
export function decodeCursorMessage(data: unknown): Record<string, unknown> | undefined {
  const s = bytesToString(data);
  if (!s || s[0] !== '{') return undefined;
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    return typeof o.role === 'string' ? o : undefined;
  } catch {
    return undefined;
  }
}

/** Turn state from messages in conversation order (oldest first). */
export function cursorState(
  messages: Record<string, unknown>[],
): Omit<ParsedSessionState, 'sessionId' | 'cwd'> {
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const c of m.content as Row[]) {
      if (typeof c?.toolCallId === 'string') resolved.add(c.toolCallId);
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return { state: 'waiting', tools: [] };
  if (last.role === 'user' || last.role === 'tool') return { state: 'active', tools: [] };
  if (last.role !== 'assistant') return { state: 'waiting', tools: [] };
  const tools: WatchedTool[] = [];
  const content = Array.isArray(last.content) ? (last.content as Row[]) : [];
  for (const c of content) {
    if (c?.type !== 'tool-call' || typeof c.toolCallId !== 'string') continue;
    if (resolved.has(c.toolCallId)) continue;
    const name = typeof c.toolName === 'string' ? c.toolName : 'tool';
    tools.push({ id: c.toolCallId, ...describeTool(name, parseToolArgs(c.args)) });
  }
  return tools.length > 0 ? { state: 'active', tools } : { state: 'waiting', tools: [] };
}

interface TrackedStore {
  mtimeMs: number;
  snapshot: WatchedSessionSnapshot;
}

function storeMtime(dbFile: string): number | undefined {
  let m: number | undefined;
  for (const f of [dbFile, `${dbFile}-wal`]) {
    try {
      const t = fs.statSync(f).mtimeMs;
      m = m === undefined ? t : Math.max(m, t);
    } catch {
      /* missing sidecar */
    }
  }
  return m;
}

export class CursorWatcher implements ProviderWatcher {
  readonly providerId = 'cursor' as const;
  private readonly lister = new DirLister();
  private readonly tracked = new Map<string, TrackedStore>();
  private readonly listed = new Set<string>();
  private lastFull = Number.NEGATIVE_INFINITY;

  constructor(private readonly chatsRoot: string) {}

  poll(now: number): WatchedSessionSnapshot[] {
    const full = now - this.lastFull >= PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS;
    if (full) this.lastFull = now;
    this.lister.force = full;
    const stores: string[] = [];
    for (const bucket of this.lister.dirs(this.chatsRoot)) {
      for (const session of this.lister.dirs(bucket)) {
        stores.push(path.join(session, 'store.db'));
      }
    }
    this.lister.force = false;
    if (stores.length > 0 && !loadSqlite()) {
      reportSqliteUnavailable(this.providerId);
      return [];
    }

    for (const db of stores) {
      if (this.tracked.has(db) || (!full && this.listed.has(db))) continue;
      const m = storeMtime(db);
      if (m === undefined || now - m > PROVIDER_WATCH_ACTIVE_WINDOW_MS) continue;
      const snap = this.read(db, m);
      if (snap) this.tracked.set(db, { mtimeMs: m, snapshot: snap });
    }
    this.listed.clear();
    for (const s of stores) this.listed.add(s);

    const out: WatchedSessionSnapshot[] = [];
    for (const [db, t] of [...this.tracked]) {
      const m = storeMtime(db);
      if (m === undefined) {
        this.tracked.delete(db);
        continue;
      }
      if (m !== t.mtimeMs) {
        const snap = this.read(db, m);
        if (snap) t.snapshot = snap;
        t.mtimeMs = m;
      }
      if (now - t.snapshot.lastActivity > PROVIDER_WATCH_REMOVE_AFTER_MS) {
        this.tracked.delete(db);
        continue;
      }
      out.push(t.snapshot);
    }
    return out;
  }

  dispose(): void {
    this.tracked.clear();
  }

  private read(dbFile: string, mtimeMs: number): WatchedSessionSnapshot | undefined {
    const db = openReadOnly(dbFile);
    if (!db) return undefined;
    try {
      const metaRow = db.prepare("SELECT value FROM meta WHERE key = '0'").get() as Row | undefined;
      const meta = decodeCursorMeta(metaRow?.value);
      const rows = db
        .prepare('SELECT data FROM blobs ORDER BY rowid DESC LIMIT ?')
        .all(CURSOR_RECENT_BLOBS) as Row[];
      const messages = rows
        .map((r) => decodeCursorMessage(r.data))
        .filter((m): m is Record<string, unknown> => !!m)
        .reverse();
      const parsed = cursorState(messages);
      return {
        ...parsed,
        providerId: this.providerId,
        sessionId: path.basename(path.dirname(dbFile)),
        cwd: typeof meta?.workspacePath === 'string' ? meta.workspacePath : undefined,
        title: typeof meta?.name === 'string' ? meta.name : undefined,
        sourcePath: dbFile,
        lastActivity: mtimeMs,
      };
    } catch {
      return undefined;
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}

export function createCursorWatcher(home = os.homedir()): CursorWatcher {
  return new CursorWatcher(path.join(home, '.cursor', 'chats'));
}
