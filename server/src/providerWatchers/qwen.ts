/**
 * Qwen Code (QwenLM/qwen-code, a Gemini CLI fork). NOT installed on the dev
 * machine — implemented from public descriptions of its chat recording:
 *
 *   ~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl   (current)
 *   ~/.qwen/tmp/<hash>/chats/session-*.json                    (older, Gemini-style)
 *
 * Current records: {uuid, parentUuid, sessionId, timestamp, type:
 * user|assistant|tool_result|system, cwd, message: {role, parts: [{text} |
 * {functionCall: {id, name, args}} | {functionResponse: {id, name}}]}}.
 * Tool names follow Gemini CLI (run_shell_command, read_file, edit, ...).
 */

import * as os from 'os';
import * as path from 'path';

import type { SessionFileParser } from './fileSessionWatcher.js';
import {
  FileSessionWatcher,
  parseTimestamp,
  ToolTracker,
  tryParseJson,
} from './fileSessionWatcher.js';
import { createGeminiStyleWatcher } from './gemini.js';
import { describeTool, parseToolArgs } from './toolLabels.js';
import type { ParsedSessionState } from './types.js';

type Part = Record<string, unknown>;

export class QwenSessionParser implements SessionFileParser {
  private sessionId?: string;
  private cwd?: string;
  private lastEventAt?: number;
  private lastType?: string;
  private lastAssistantHadCalls = false;
  private readonly tools = new ToolTracker();

  feedLine(line: string): void {
    const r = tryParseJson(line);
    if (!r) return;
    if (typeof r.sessionId === 'string') this.sessionId = r.sessionId;
    if (typeof r.cwd === 'string' && r.cwd) this.cwd = r.cwd;
    const ts = parseTimestamp(r.timestamp);
    if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    const type = typeof r.type === 'string' ? r.type : undefined;
    if (!type || type === 'system') return;
    const message = (r.message ?? {}) as Record<string, unknown>;
    const parts = Array.isArray(message.parts) ? (message.parts as Part[]) : [];
    const role = message.role;
    const kind = role === 'model' ? 'assistant' : type;
    if (kind === 'user' && parts.some((p) => p.functionResponse)) {
      this.onResponses(parts);
      this.lastType = 'tool_result';
      return;
    }
    switch (kind) {
      case 'user':
        this.tools.clear();
        this.lastType = 'user';
        return;
      case 'assistant': {
        // A new model step means the previous step's calls have all returned.
        this.tools.clear();
        let calls = 0;
        parts.forEach((p, i) => {
          const fc = p.functionCall as Record<string, unknown> | undefined;
          if (!fc) return;
          calls++;
          const name = typeof fc.name === 'string' ? fc.name : 'tool';
          const id =
            typeof fc.id === 'string' ? fc.id : `${typeof r.uuid === 'string' ? r.uuid : 'a'}-${i}`;
          this.tools.start(id, describeTool(name, parseToolArgs(fc.args)));
        });
        this.lastAssistantHadCalls = calls > 0 || this.tools.size > 0;
        this.lastType = 'assistant';
        return;
      }
      case 'tool_result':
        this.onResponses(parts);
        this.lastType = 'tool_result';
        return;
    }
  }

  private onResponses(parts: Part[]): void {
    for (const p of parts) {
      const fr = p.functionResponse as Record<string, unknown> | undefined;
      if (!fr) continue;
      if (typeof fr.id === 'string') {
        this.tools.end(fr.id);
      } else {
        // No id to pair on: retire the oldest running call.
        const oldest = this.tools.list()[0];
        if (oldest) this.tools.end(oldest.id);
      }
    }
  }

  state(): ParsedSessionState {
    const base = { sessionId: this.sessionId, cwd: this.cwd, lastEventAt: this.lastEventAt };
    switch (this.lastType) {
      case 'user':
      case 'tool_result':
        return { ...base, state: 'active', tools: this.tools.list() };
      case 'assistant':
        return this.lastAssistantHadCalls
          ? { ...base, state: 'active', tools: this.tools.list() }
          : { ...base, state: 'waiting', tools: [] };
      default:
        return { ...base, state: 'waiting', tools: [] };
    }
  }
}

export function createQwenWatchers(home = os.homedir()): FileSessionWatcher[] {
  const qwenHome = path.join(home, '.qwen');
  const projectsRoot = path.join(qwenHome, 'projects');
  return [
    new FileSessionWatcher({
      providerId: 'qwen',
      listFiles: (lister) => {
        const out: string[] = [];
        for (const project of lister.dirs(projectsRoot)) {
          out.push(...lister.files(path.join(project, 'chats'), (n) => n.endsWith('.jsonl')));
        }
        return out;
      },
      createParser: () => new QwenSessionParser(),
    }),
    createGeminiStyleWatcher('qwen', path.join(qwenHome, 'tmp'), 'json'),
    createGeminiStyleWatcher('qwen', path.join(qwenHome, 'tmp'), 'jsonl'),
  ];
}
