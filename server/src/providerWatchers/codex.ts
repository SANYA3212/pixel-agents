/**
 * Codex (CLI and Codex Desktop): ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
 *
 * Verified against real rollouts on disk (structure only):
 *  - `session_meta` (first line): payload.id / session_id, cwd, originator
 *    ("Codex Desktop", "codex_exec", "codex_cli_rs"), source (a sub-agent
 *    thread carries source.subagent.thread_spawn.agent_nickname)
 *  - `turn_context`: payload.cwd
 *  - `event_msg` payload.type task_started -> turn begins;
 *    task_complete / turn_aborted -> turn over (waiting)
 *  - `response_item` payload.type function_call / custom_tool_call start a
 *    tool (call_id); *_output ends it. Newer Codex runs in "code mode": one
 *    custom tool `exec` whose input is a JS cell calling tools.exec_command({cmd}),
 *    tools.apply_patch(...), tools.web__run(...), ... — the label comes from the
 *    first such call.
 * Older event_msg exec_command_begin/_end and patch_apply_begin/_end are also
 * understood (documented in the Codex CLI protocol, not on this machine).
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
import { commandArg, describeTool, parseToolArgs, patchTool, shellTool } from './toolLabels.js';
import type { ParsedSessionState } from './types.js';

type Tool = { name: string; status: string };

const SHELL_FUNCTIONS = new Set([
  'shell',
  'shell_command',
  'exec_command',
  'container.exec',
  'local_shell',
  'unified_exec',
]);

/** Read a JS string literal starting at `src[start]` (", ' or `). */
function readStringLiteral(src: string, start: number): string | undefined {
  const quote = src[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
  let out = '';
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      const n = src[++i];
      out += n === 'n' ? ' ' : n === 't' ? ' ' : n;
      continue;
    }
    if (c === quote) return out;
    out += c;
  }
  return undefined;
}

/** Label for a code-mode `exec` cell: the first tools.<name>(...) call it makes. */
export function codexCodeModeTool(input: string): Tool {
  const re = /tools\.([A-Za-z0-9_]+)\s*\(/g;
  const m = re.exec(input);
  if (!m) {
    // Plain JS cells; computer-use cells drive the desktop through `sky.*`.
    if (/\bsky\.[A-Za-z_]+\s*\(/.test(input)) return { name: 'computer', status: 'Using computer' };
    return { name: 'Bash', status: 'Running code' };
  }
  const fn = m[1];
  const rest = input.slice(m.index + m[0].length);
  switch (fn) {
    case 'exec_command':
    case 'shell':
    case 'shell_command': {
      const cmdKey = /\b(?:cmd|command)\s*:\s*/.exec(rest);
      const literal = cmdKey ? readStringLiteral(rest, cmdKey.index + cmdKey[0].length) : undefined;
      return literal ? shellTool(literal) : { name: 'Bash', status: 'Running command' };
    }
    case 'apply_patch':
      return patchTool(input) ?? { name: 'Edit', status: 'Editing files' };
    case 'write_stdin':
      return { name: 'Bash', status: 'Writing to terminal' };
    case 'web__run':
      return /^\s*\{\s*search_query\b/.test(rest)
        ? { name: 'WebSearch', status: 'Searching the web' }
        : { name: 'WebFetch', status: 'Fetching web content' };
    default:
      return describeTool(fn, {});
  }
}

/** Label for a classic function_call. */
export function codexFunctionTool(name: string, rawArgs: unknown, lastExec?: Tool): Tool {
  const args = parseToolArgs(rawArgs);
  if (SHELL_FUNCTIONS.has(name)) {
    const cmd = commandArg(args);
    return cmd ? shellTool(cmd) : { name: 'Bash', status: 'Running command' };
  }
  switch (name) {
    case 'apply_patch': {
      const input = typeof args.input === 'string' ? args.input : String(rawArgs ?? '');
      return patchTool(input) ?? { name: 'Edit', status: 'Editing files' };
    }
    case 'write_stdin':
      return { name: 'Bash', status: 'Writing to terminal' };
    case 'wait':
      // Waiting on a yielded exec cell: keep showing what it runs.
      return lastExec ?? { name: 'Bash', status: 'Waiting for command' };
    case 'sleep':
      return { name: 'Bash', status: 'Waiting' };
    case 'send_message':
      return { name: 'send_message', status: 'Messaging agent' };
    case 'view_image':
      return { name: 'Read', status: 'Viewing image' };
    default:
      return describeTool(name, args);
  }
}

export class CodexSessionParser implements SessionFileParser {
  private sessionId?: string;
  private cwd?: string;
  private variant?: string;
  private labelDetail?: string;
  private turnOpen = false;
  private lastEventAt?: number;
  private lastExec?: Tool;
  private readonly tools = new ToolTracker();

  feedLine(line: string): void {
    const r = tryParseJson(line);
    if (!r) return;
    const ts = parseTimestamp(r.timestamp);
    if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    switch (r.type) {
      case 'session_meta':
        this.onSessionMeta(payload);
        return;
      case 'turn_context':
        if (typeof payload.cwd === 'string') this.cwd = payload.cwd;
        return;
      case 'event_msg':
        this.onEvent(payload);
        return;
      case 'response_item':
        this.onResponseItem(payload);
        return;
    }
  }

  private onSessionMeta(p: Record<string, unknown>): void {
    const id = p.id ?? p.session_id;
    if (typeof id === 'string') this.sessionId = id;
    if (typeof p.cwd === 'string') this.cwd = p.cwd;
    const originator = typeof p.originator === 'string' ? p.originator : '';
    if (/desktop/i.test(originator)) this.variant = 'Codex Desktop';
    const source = p.source as Record<string, unknown> | undefined;
    const spawn = (source?.subagent as Record<string, unknown> | undefined)?.thread_spawn as
      Record<string, unknown> | undefined;
    const nickname = p.agent_nickname ?? spawn?.agent_nickname;
    if (typeof nickname === 'string' && nickname) this.labelDetail = nickname;
  }

  private onEvent(p: Record<string, unknown>): void {
    const callId = typeof p.call_id === 'string' ? p.call_id : '';
    switch (p.type) {
      case 'task_started':
        this.turnOpen = true;
        return;
      case 'task_complete':
      case 'turn_aborted':
        this.turnOpen = false;
        this.tools.clear();
        return;
      case 'exec_command_begin': {
        this.turnOpen = true;
        if (callId && !this.tools.has(callId)) {
          const cmd = commandArg(p);
          this.tools.start(
            callId,
            cmd ? shellTool(cmd) : { name: 'Bash', status: 'Running command' },
          );
        }
        return;
      }
      case 'patch_apply_begin': {
        this.turnOpen = true;
        if (callId && !this.tools.has(callId)) {
          const changes = p.changes && typeof p.changes === 'object' ? Object.keys(p.changes) : [];
          const first = changes[0];
          this.tools.start(
            callId,
            first
              ? describeTool('edit', { path: first })
              : { name: 'Edit', status: 'Editing files' },
          );
        }
        return;
      }
      case 'mcp_tool_call_begin': {
        this.turnOpen = true;
        const inv = (p.invocation ?? {}) as Record<string, unknown>;
        if (callId) {
          this.tools.start(callId, {
            name: 'mcp',
            status: `Using ${String(inv.server ?? 'mcp')}: ${String(inv.tool ?? 'tool')}`,
          });
        }
        return;
      }
      case 'web_search_begin':
        if (callId) this.tools.start(callId, { name: 'WebSearch', status: 'Searching the web' });
        return;
      case 'exec_command_end':
      case 'patch_apply_end':
      case 'mcp_tool_call_end':
      case 'web_search_end':
        if (callId) this.tools.end(callId);
        return;
    }
  }

  private onResponseItem(p: Record<string, unknown>): void {
    const callId = typeof p.call_id === 'string' ? p.call_id : '';
    switch (p.type) {
      case 'function_call': {
        this.turnOpen = true;
        const name = typeof p.name === 'string' ? p.name : 'tool';
        if (callId) this.tools.start(callId, codexFunctionTool(name, p.arguments, this.lastExec));
        return;
      }
      case 'custom_tool_call': {
        this.turnOpen = true;
        const name = typeof p.name === 'string' ? p.name : 'tool';
        const input = typeof p.input === 'string' ? p.input : '';
        let tool: Tool;
        if (name === 'exec') {
          tool = codexCodeModeTool(input);
          this.lastExec = tool;
        } else if (name === 'apply_patch') {
          tool = patchTool(input) ?? { name: 'Edit', status: 'Editing files' };
        } else {
          tool = describeTool(name, {});
        }
        if (callId) this.tools.start(callId, tool);
        return;
      }
      case 'local_shell_call': {
        this.turnOpen = true;
        const action = (p.action ?? {}) as Record<string, unknown>;
        const cmd = commandArg(action);
        const id = callId || (typeof p.id === 'string' ? p.id : '');
        if (id)
          this.tools.start(id, cmd ? shellTool(cmd) : { name: 'Bash', status: 'Running command' });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output':
        if (callId) this.tools.end(callId);
        return;
      case 'reasoning':
        this.turnOpen = true;
        return;
      case 'message':
        if (p.role === 'user') this.turnOpen = true;
        return;
    }
  }

  state(): ParsedSessionState {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      variant: this.variant,
      labelDetail: this.labelDetail,
      state: this.turnOpen ? 'active' : 'waiting',
      tools: this.turnOpen ? this.tools.list() : [],
      lastEventAt: this.lastEventAt,
    };
  }
}

/** Rollout files: every YYYY/MM/DD day directory under the sessions root. */
export function listCodexRollouts(lister: DirLister, root: string): string[] {
  const out: string[] = [];
  for (const year of lister.dirs(root)) {
    for (const month of lister.dirs(year)) {
      for (const day of lister.dirs(month)) {
        out.push(...lister.files(day, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl')));
      }
    }
  }
  return out;
}

export function createCodexWatcher(home = os.homedir()): FileSessionWatcher {
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const root = path.join(codexHome, 'sessions');
  return new FileSessionWatcher({
    providerId: 'codex',
    listFiles: (lister) => listCodexRollouts(lister, root),
    createParser: () => new CodexSessionParser(),
    sessionIdFromPath: (file) => {
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
        file,
      );
      return m ? m[1] : path.basename(file, '.jsonl');
    },
  });
}
