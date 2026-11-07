/**
 * FileSessionWatcher: the shared engine for providers that keep one file per
 * session (Codex rollouts, Gemini/Qwen chats, Kimi wire logs, Copilot events).
 *
 * Read-only and poll-based (fs.watch is unreliable on Windows):
 *  - discovery lists candidate files through a DirLister that re-reads a
 *    directory only when its mtime changed, so an idle tick costs a few stats;
 *    newly listed files are stat'ed at once, every untracked file is re-stat'ed
 *    on the periodic full rescan (catches a resumed old session);
 *  - a file is adopted when it was modified inside the adoption window;
 *  - adoption reads the file whole when small, else its first line (session
 *    metadata) plus a tail (current turn); later polls read only appended bytes,
 *    carrying an unterminated last line to the next poll;
 *  - a tracked file goes untracked when deleted or quiet past the removal window.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  PROVIDER_WATCH_ACTIVE_WINDOW_MS,
  PROVIDER_WATCH_FULL_READ_MAX_BYTES,
  PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS,
  PROVIDER_WATCH_HEAD_READ_MAX_BYTES,
  PROVIDER_WATCH_MAX_READ_PER_POLL_BYTES,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
  PROVIDER_WATCH_TAIL_READ_BYTES,
} from '../constants.js';
import type {
  ParsedSessionState,
  ProviderWatcher,
  WatchedProviderId,
  WatchedSessionSnapshot,
} from './types.js';

/** Incremental parser for one session file. */
export interface SessionFileParser {
  /** JSONL mode: one complete line (without the newline). Must never throw. */
  feedLine?(line: string): void;
  /** JSON mode: the whole parsed document (re-fed from scratch on every change). */
  feedDocument?(doc: unknown): void;
  state(): ParsedSessionState;
}

export interface FileSessionWatcherOptions {
  providerId: WatchedProviderId;
  /** Every candidate session file (absolute paths). Use the given DirLister. */
  listFiles(lister: DirLister): string[];
  createParser(file: string): SessionFileParser;
  /** 'jsonl' (default): append-only lines. 'json': a document rewritten in place. */
  format?: 'jsonl' | 'json';
  /** Session id used when the parser found none (default: file name sans extension). */
  sessionIdFromPath?(file: string): string;
}

/** Cached directory listings, refreshed when the directory's mtime moves. */
export class DirLister {
  private readonly cache = new Map<string, { mtimeMs: number; entries: fs.Dirent[] }>();
  /** When true, every list() re-reads the directory (full rescans). */
  force = false;

  list(dir: string): fs.Dirent[] {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      this.cache.delete(dir);
      return [];
    }
    const cached = this.cache.get(dir);
    if (cached && !this.force && cached.mtimeMs === mtimeMs) return cached.entries;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    this.cache.set(dir, { mtimeMs, entries });
    return entries;
  }

  /** Sub-directory paths of `dir`. */
  dirs(dir: string): string[] {
    return this.list(dir)
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  }

  /** File paths of `dir` whose name passes `filter`. */
  files(dir: string, filter: (name: string) => boolean): string[] {
    return this.list(dir)
      .filter((e) => e.isFile() && filter(e.name))
      .map((e) => path.join(dir, e.name));
  }
}

interface TrackedFile {
  file: string;
  parser: SessionFileParser;
  offset: number;
  partial: Buffer;
  mtimeMs: number;
  size: number;
}

export class FileSessionWatcher implements ProviderWatcher {
  readonly providerId: WatchedProviderId;
  private readonly tracked = new Map<string, TrackedFile>();
  private readonly listedFiles = new Set<string>();
  private readonly lister = new DirLister();
  private lastFullScan = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: FileSessionWatcherOptions) {
    this.providerId = opts.providerId;
  }

  poll(now: number): WatchedSessionSnapshot[] {
    const full = now - this.lastFullScan >= PROVIDER_WATCH_FULL_RESCAN_INTERVAL_MS;
    if (full) this.lastFullScan = now;
    this.lister.force = full;
    let candidates: string[];
    try {
      candidates = this.opts.listFiles(this.lister);
    } catch {
      candidates = [];
    }
    this.lister.force = false;

    const listedNow = new Set(candidates);
    for (const file of candidates) {
      if (this.tracked.has(file)) continue;
      // Between full rescans only files that just appeared are stat'ed.
      if (!full && this.listedFiles.has(file)) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > PROVIDER_WATCH_ACTIVE_WINDOW_MS) continue;
      this.adopt(file, st);
    }
    this.listedFiles.clear();
    for (const f of listedNow) this.listedFiles.add(f);

    const snapshots: WatchedSessionSnapshot[] = [];
    for (const [key, t] of [...this.tracked]) {
      let st: fs.Stats;
      try {
        st = fs.statSync(t.file);
      } catch {
        this.tracked.delete(key);
        continue;
      }
      const behind = this.opts.format !== 'json' && t.offset < st.size;
      if (st.mtimeMs !== t.mtimeMs || st.size !== t.size || behind) {
        this.refresh(t, st);
      }
      const snap = this.snapshotOf(t);
      if (now - snap.lastActivity > PROVIDER_WATCH_REMOVE_AFTER_MS) {
        this.tracked.delete(key);
        continue;
      }
      snapshots.push(snap);
    }
    return snapshots;
  }

  dispose(): void {
    this.tracked.clear();
  }

  // ── internals ──

  private snapshotOf(t: TrackedFile): WatchedSessionSnapshot {
    let state: ParsedSessionState;
    try {
      state = t.parser.state();
    } catch {
      state = { state: 'waiting', tools: [] };
    }
    const fallbackId = this.opts.sessionIdFromPath
      ? this.opts.sessionIdFromPath(t.file)
      : path.basename(t.file).replace(/\.[^.]+$/, '');
    return {
      ...state,
      providerId: this.providerId,
      sessionId: state.sessionId || fallbackId || t.file,
      sourcePath: t.file,
      lastActivity: Math.max(t.mtimeMs, state.lastEventAt ?? 0),
    };
  }

  private adopt(file: string, st: fs.Stats): void {
    const t: TrackedFile = {
      file,
      parser: this.opts.createParser(file),
      offset: 0,
      partial: Buffer.alloc(0),
      mtimeMs: st.mtimeMs,
      size: st.size,
    };
    if (this.opts.format === 'json') {
      this.readDocument(t);
    } else if (st.size <= PROVIDER_WATCH_FULL_READ_MAX_BYTES) {
      this.readAppended(t, st.size);
    } else {
      // Head (metadata line) + tail (current state); the middle is history.
      const head = readRange(file, 0, Math.min(st.size, PROVIDER_WATCH_HEAD_READ_MAX_BYTES));
      const nl = head ? head.indexOf(0x0a) : -1;
      if (head && nl > 0) this.feed(t, head.subarray(0, nl).toString('utf8'));
      const start = Math.max(0, st.size - PROVIDER_WATCH_TAIL_READ_BYTES);
      const tail = readRange(file, start, st.size);
      if (tail) {
        const firstNl = tail.indexOf(0x0a);
        t.offset = st.size;
        if (firstNl >= 0) this.consume(t, tail.subarray(firstNl + 1));
      } else {
        t.offset = st.size;
      }
    }
    this.tracked.set(file, t);
  }

  private refresh(t: TrackedFile, st: fs.Stats): void {
    if (this.opts.format === 'json') {
      t.mtimeMs = st.mtimeMs;
      t.size = st.size;
      this.readDocument(t);
      return;
    }
    if (st.size < t.offset) {
      // Truncated / rewritten: start over.
      t.parser = this.opts.createParser(t.file);
      t.offset = 0;
      t.partial = Buffer.alloc(0);
    }
    t.mtimeMs = st.mtimeMs;
    t.size = st.size;
    this.readAppended(t, st.size);
  }

  private readAppended(t: TrackedFile, size: number): void {
    if (size <= t.offset) return;
    const end = Math.min(size, t.offset + PROVIDER_WATCH_MAX_READ_PER_POLL_BYTES);
    const buf = readRange(t.file, t.offset, end);
    if (!buf) return;
    t.offset += buf.length;
    this.consume(t, buf);
  }

  /** Split a chunk into complete lines; keep the unterminated rest. */
  private consume(t: TrackedFile, chunk: Buffer): void {
    let data = t.partial.length > 0 ? Buffer.concat([t.partial, chunk]) : chunk;
    let nl = data.indexOf(0x0a);
    while (nl >= 0) {
      const line = data.subarray(0, nl).toString('utf8');
      this.feed(t, line);
      data = data.subarray(nl + 1);
      nl = data.indexOf(0x0a);
    }
    t.partial = Buffer.from(data);
  }

  private feed(t: TrackedFile, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      t.parser.feedLine?.(trimmed);
    } catch {
      /* a parser bug must not stop the watcher */
    }
  }

  private readDocument(t: TrackedFile): void {
    const buf = readRange(t.file, 0, t.size);
    if (!buf) return;
    let doc: unknown;
    try {
      doc = JSON.parse(buf.toString('utf8'));
    } catch {
      return; // mid-write; keep the previous state
    }
    const parser = this.opts.createParser(t.file);
    try {
      parser.feedDocument?.(doc);
    } catch {
      return;
    }
    t.parser = parser;
    t.offset = t.size;
  }
}

/** Read bytes [start, end) of a file, or null on error. */
export function readRange(file: string, start: number, end: number): Buffer | null {
  if (end <= start) return Buffer.alloc(0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(end - start);
    const n = fs.readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Parse a timestamp field (ISO string, ms or s number) to ms, or undefined. */
export function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v; // seconds vs milliseconds
  }
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/** JSON.parse that returns undefined instead of throwing. */
export function tryParseJson(line: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Ordered map of running tools, keyed by call id. */
export class ToolTracker {
  private readonly tools = new Map<string, { name: string; status: string }>();

  start(id: string, tool: { name: string; status: string }): void {
    if (!id) return;
    this.tools.set(id, tool);
  }

  end(id: string): void {
    this.tools.delete(id);
  }

  clear(): void {
    this.tools.clear();
  }

  get size(): number {
    return this.tools.size;
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): { id: string; name: string; status: string }[] {
    return [...this.tools].map(([id, t]) => ({ id, ...t }));
  }
}
