/**
 * Gemini CLI (and the legacy Qwen Code layout, a Gemini CLI fork):
 *   ~/.gemini/tmp/<project>/chats/session-*.jsonl   (current, verified on disk)
 *   ~/.gemini/tmp/<project>/chats/<parent>/<id>.jsonl (sub-agent chats, kind "subagent")
 *   ~/.gemini/tmp/<hash>/chats/session-*.json        (older Gemini CLI: one JSON
 *                                                      document, rewritten in place)
 *   <project>/.project_root                          working directory of the project
 *
 * JSONL records (verified): a header {sessionId, projectHash, startTime,
 * lastUpdated, kind?, directories?}; message records {id, timestamp, type:
 * user|gemini|info|error, content, toolCalls?: [{id, name, args, status}]} —
 * a message is re-appended under the same id as it progresses (last write
 * wins); `{"$set": {...}}` patches the header. The JSON document holds the
 * same messages in `messages`.
 *
 * Gemini writes a model message only once it is complete, so a tool usually
 * appears with a terminal status; non-terminal statuses (scheduled, executing,
 * awaiting_approval) are shown when present.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { DirLister, SessionFileParser } from './fileSessionWatcher.js';
import { FileSessionWatcher, parseTimestamp, tryParseJson } from './fileSessionWatcher.js';
import { describeTool, parseToolArgs } from './toolLabels.js';
import type { ParsedSessionState, WatchedProviderId, WatchedTool } from './types.js';

const TERMINAL_TOOL_STATUSES = new Set(['success', 'error', 'cancelled', 'canceled', 'failed']);
/** Tools that end a sub-agent's run. */
const COMPLETION_TOOLS = new Set(['complete_task']);
const MODEL_TYPES = new Set(['gemini', 'model', 'assistant', 'qwen']);
const USER_TYPES = new Set(['user']);

interface ChatMessage {
  id?: string;
  type?: string;
  timestamp?: unknown;
  toolCalls?: unknown;
}

export class GeminiChatParser implements SessionFileParser {
  private sessionId?: string;
  private cwd?: string;
  private kind?: string;
  private lastEventAt?: number;
  private readonly messages = new Map<string, ChatMessage>();
  private anonCounter = 0;

  constructor(cwd?: string) {
    this.cwd = cwd;
  }

  feedLine(line: string): void {
    const r = tryParseJson(line);
    if (!r) return;
    if (r.$set && typeof r.$set === 'object') {
      this.onHeader(r.$set as Record<string, unknown>);
      return;
    }
    if (typeof r.type !== 'string') {
      this.onHeader(r);
      return;
    }
    this.onMessage(r as ChatMessage);
  }

  feedDocument(doc: unknown): void {
    if (!doc || typeof doc !== 'object') return;
    const d = doc as Record<string, unknown>;
    this.onHeader(d);
    if (Array.isArray(d.messages)) {
      for (const m of d.messages) {
        if (m && typeof m === 'object') this.onMessage(m as ChatMessage);
      }
    }
  }

  private onHeader(h: Record<string, unknown>): void {
    if (typeof h.sessionId === 'string') this.sessionId = h.sessionId;
    if (typeof h.kind === 'string') this.kind = h.kind;
    if (!this.cwd && Array.isArray(h.directories) && typeof h.directories[0] === 'string') {
      this.cwd = h.directories[0];
    }
    for (const k of ['lastUpdated', 'startTime']) {
      const ts = parseTimestamp(h[k]);
      if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    }
  }

  private onMessage(m: ChatMessage): void {
    const ts = parseTimestamp(m.timestamp);
    if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    const id = typeof m.id === 'string' ? m.id : `anon-${this.anonCounter++}`;
    this.messages.set(id, m);
  }

  state(): ParsedSessionState {
    const base = {
      sessionId: this.sessionId,
      cwd: this.cwd,
      labelDetail: this.kind === 'subagent' ? 'subagent' : undefined,
      lastEventAt: this.lastEventAt,
    };
    const last = [...this.messages.values()].pop();
    if (!last || !last.type) return { ...base, state: 'waiting', tools: [] };
    if (USER_TYPES.has(last.type)) return { ...base, state: 'active', tools: [] };
    if (!MODEL_TYPES.has(last.type)) return { ...base, state: 'waiting', tools: [] };
    const calls = Array.isArray(last.toolCalls)
      ? (last.toolCalls as Record<string, unknown>[])
      : [];
    if (calls.length === 0) return { ...base, state: 'waiting', tools: [] };
    const running: WatchedTool[] = [];
    let completed = false;
    calls.forEach((c, i) => {
      const name = typeof c.name === 'string' ? c.name : 'tool';
      if (COMPLETION_TOOLS.has(name)) completed = true;
      const status = typeof c.status === 'string' ? c.status : '';
      if (TERMINAL_TOOL_STATUSES.has(status)) return;
      const id =
        typeof c.id === 'string' ? c.id : `${typeof last.id === 'string' ? last.id : 'm'}-${i}`;
      running.push({ id, ...describeTool(name, parseToolArgs(c.args)) });
    });
    if (completed && running.length === 0) {
      // A sub-agent that reported its result is done for good.
      return { ...base, state: this.kind === 'subagent' ? 'ended' : 'waiting', tools: [] };
    }
    // Tools ran (or still run): the model takes another step.
    return { ...base, state: 'active', tools: running };
  }
}

/** Reads `<projectDir>/.project_root`, cached per directory. */
class ProjectRootCache {
  private readonly cache = new Map<string, string | undefined>();

  get(projectDir: string): string | undefined {
    if (this.cache.has(projectDir)) return this.cache.get(projectDir);
    let root: string | undefined;
    try {
      root = fs.readFileSync(path.join(projectDir, '.project_root'), 'utf8').trim() || undefined;
    } catch {
      root = undefined;
    }
    this.cache.set(projectDir, root);
    return root;
  }
}

const isChatFile = (n: string) => n.endsWith('.jsonl') || n.endsWith('.json');

/** All chat files under a Gemini-style tmp root (<root>/<project>/chats/...). */
export function listGeminiChats(lister: DirLister, tmpRoot: string): string[] {
  const out: string[] = [];
  for (const project of lister.dirs(tmpRoot)) {
    const chats = path.join(project, 'chats');
    out.push(...lister.files(chats, isChatFile));
    for (const sub of lister.dirs(chats)) {
      out.push(...lister.files(sub, (n) => n.endsWith('.jsonl')));
    }
  }
  return out;
}

/** The project dir (<root>/<project>) a chat file belongs to. */
function projectDirOf(file: string, tmpRoot: string): string {
  const rel = path.relative(tmpRoot, file).split(path.sep);
  return path.join(tmpRoot, rel[0] ?? '');
}

export function createGeminiStyleWatcher(
  providerId: WatchedProviderId,
  tmpRoot: string,
  format: 'jsonl' | 'json',
): FileSessionWatcher {
  const roots = new ProjectRootCache();
  return new FileSessionWatcher({
    providerId,
    format,
    listFiles: (lister) =>
      listGeminiChats(lister, tmpRoot).filter((f) =>
        format === 'json' ? f.endsWith('.json') : f.endsWith('.jsonl'),
      ),
    createParser: (file) => new GeminiChatParser(roots.get(projectDirOf(file, tmpRoot))),
  });
}

export function createGeminiWatchers(home = os.homedir()): FileSessionWatcher[] {
  const tmpRoot = path.join(process.env.GEMINI_CLI_HOME || home, '.gemini', 'tmp');
  return [
    createGeminiStyleWatcher('gemini', tmpRoot, 'jsonl'),
    createGeminiStyleWatcher('gemini', tmpRoot, 'json'),
  ];
}
