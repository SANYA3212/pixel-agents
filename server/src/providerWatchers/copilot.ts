/**
 * GitHub Copilot CLI. NOT installed on the dev machine — implemented from the
 * event log format third-party readers document:
 *
 *   ~/.copilot/session-state/<sessionId>/events.jsonl   (current)
 *   ~/.copilot/session-state/<sessionId>.jsonl          (older flat layout)
 *
 * Lines: {type, data, id, timestamp}. session.start data {sessionId, context:
 * {cwd}}; user.message; assistant.turn_start / assistant.turn_end;
 * assistant.message data {toolRequests?}; tool.execution_start data
 * {toolCallId, toolName, arguments}; tool.execution_complete data {toolCallId};
 * session.idle; abort; session.shutdown.
 */

import * as os from 'os';
import * as path from 'path';

import type { DirLister, SessionFileParser } from './fileSessionWatcher.js';
import {
  FileSessionWatcher,
  parseTimestamp,
  ToolTracker,
  tryParseJson,
} from './fileSessionWatcher.js';
import { describeTool, parseToolArgs } from './toolLabels.js';
import type { ParsedSessionState, WatchedSessionState } from './types.js';

export class CopilotEventsParser implements SessionFileParser {
  private sessionId?: string;
  private cwd?: string;
  private state_: WatchedSessionState = 'waiting';
  private lastEventAt?: number;
  /** Whether the newest assistant.message asked for tools (turn continues). */
  private pendingToolRequests = false;
  private readonly tools = new ToolTracker();

  feedLine(line: string): void {
    const r = tryParseJson(line);
    if (!r) return;
    const ts = parseTimestamp(r.timestamp);
    if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    const data = (r.data ?? {}) as Record<string, unknown>;
    switch (r.type) {
      case 'session.start':
      case 'session.resume': {
        if (typeof data.sessionId === 'string') this.sessionId = data.sessionId;
        const ctx = (data.context ?? {}) as Record<string, unknown>;
        if (typeof ctx.cwd === 'string') this.cwd = ctx.cwd;
        if (this.state_ === 'ended') this.state_ = 'waiting';
        return;
      }
      case 'user.message':
      case 'assistant.turn_start':
        this.state_ = 'active';
        return;
      case 'assistant.message': {
        const reqs = data.toolRequests;
        this.pendingToolRequests = Array.isArray(reqs) && reqs.length > 0;
        this.state_ = 'active';
        return;
      }
      case 'tool.execution_start': {
        this.state_ = 'active';
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        const name = typeof data.toolName === 'string' ? data.toolName : 'tool';
        const args = parseToolArgs(data.arguments);
        if (id) {
          this.tools.start(
            id,
            name === 'report_intent' && typeof args.intent === 'string'
              ? { name, status: args.intent }
              : describeTool(name, args),
          );
        }
        return;
      }
      case 'tool.execution_complete': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        if (id) this.tools.end(id);
        return;
      }
      case 'assistant.turn_end':
        if (!this.pendingToolRequests && this.tools.size === 0) this.state_ = 'waiting';
        return;
      case 'session.idle':
      case 'abort':
      case 'session.error':
        this.state_ = 'waiting';
        this.tools.clear();
        this.pendingToolRequests = false;
        return;
      case 'session.shutdown':
        this.state_ = 'ended';
        this.tools.clear();
        return;
    }
  }

  state(): ParsedSessionState {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      state: this.state_,
      tools: this.state_ === 'active' ? this.tools.list() : [],
      lastEventAt: this.lastEventAt,
    };
  }
}

export function createCopilotWatcher(home = os.homedir()): FileSessionWatcher {
  const root = path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state');
  return new FileSessionWatcher({
    providerId: 'copilot',
    listFiles: (lister: DirLister) => {
      const out = lister.files(root, (n) => n.endsWith('.jsonl'));
      for (const dir of lister.dirs(root)) {
        out.push(...lister.files(dir, (n) => n === 'events.jsonl'));
      }
      return out;
    },
    createParser: () => new CopilotEventsParser(),
    sessionIdFromPath: (file) =>
      path.basename(file) === 'events.jsonl'
        ? path.basename(path.dirname(file))
        : path.basename(file, '.jsonl'),
  });
}
