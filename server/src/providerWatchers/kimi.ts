/**
 * Kimi Code CLI (MoonshotAI kimi-cli). NOT installed on the dev machine —
 * implemented from its documentation (data locations + Wire protocol):
 *
 *   ~/.kimi/sessions/<md5(workdir)>/<sessionId>/wire.jsonl          (kimi-cli)
 *   ~/.kimi-code/sessions/<key>/<sessionId>/agents/main/wire.jsonl  (Kimi Code)
 *   ~/.kimi/kimi.json  maps work directories (work_dirs[].path) -> md5 bucket
 *
 * wire.jsonl lines: {timestamp, message: {type, payload}} with Wire events
 * TurnBegin / TurnEnd / StepBegin / StepInterrupted / ToolCall {id, function:
 * {name, arguments}} / ToolResult {tool_call_id} / ApprovalRequest / ...
 * Tool names: Shell, ReadFile, WriteFile, StrReplaceFile, Grep, Glob,
 * SearchWeb, FetchURL, Task, SetTodoList.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
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
import type { ParsedSessionState } from './types.js';

export class KimiWireParser implements SessionFileParser {
  private turnOpen = false;
  private lastEventAt?: number;
  private readonly tools = new ToolTracker();

  constructor(
    private readonly sessionId?: string,
    private readonly cwd?: string,
  ) {}

  feedLine(line: string): void {
    const r = tryParseJson(line);
    if (!r) return;
    const ts = parseTimestamp(r.timestamp);
    if (ts !== undefined) this.lastEventAt = Math.max(this.lastEventAt ?? 0, ts);
    const msg = (r.message && typeof r.message === 'object' ? r.message : r) as Record<
      string,
      unknown
    >;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    switch (msg.type) {
      case 'TurnBegin':
      case 'SteerInput':
      case 'StepBegin':
      case 'CompactionBegin':
        this.turnOpen = true;
        return;
      case 'TurnEnd':
      case 'StepInterrupted':
        this.turnOpen = false;
        this.tools.clear();
        return;
      case 'ToolCall': {
        this.turnOpen = true;
        const fn = (payload.function ?? {}) as Record<string, unknown>;
        const id = typeof payload.id === 'string' ? payload.id : '';
        const name = typeof fn.name === 'string' ? fn.name : 'tool';
        if (id) this.tools.start(id, describeTool(name, parseToolArgs(fn.arguments)));
        return;
      }
      case 'ToolResult': {
        const id = typeof payload.tool_call_id === 'string' ? payload.tool_call_id : '';
        if (id) this.tools.end(id);
        return;
      }
    }
  }

  state(): ParsedSessionState {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      state: this.turnOpen ? 'active' : 'waiting',
      tools: this.turnOpen ? this.tools.list() : [],
      lastEventAt: this.lastEventAt,
    };
  }
}

/** md5(workdir) -> workdir, from ~/.kimi/kimi.json (re-read when it changes). */
class KimiWorkDirs {
  private mtimeMs = -1;
  private map = new Map<string, string>();

  constructor(private readonly file: string) {}

  resolve(bucket: string): string | undefined {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs !== this.mtimeMs) {
        this.mtimeMs = st.mtimeMs;
        this.map = new Map();
        const cfg = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
        const dirs = Array.isArray(cfg.work_dirs) ? cfg.work_dirs : [];
        for (const d of dirs) {
          const p = typeof d === 'string' ? d : (d as Record<string, unknown>)?.path;
          if (typeof p === 'string') {
            this.map.set(crypto.createHash('md5').update(p, 'utf8').digest('hex'), p);
          }
        }
      }
    } catch {
      /* no kimi.json: fall back to state.json / nothing */
    }
    return this.map.get(bucket);
  }
}

/** Best-effort cwd from a session's state.json (field names vary by version). */
function cwdFromStateJson(sessionDir: string): string | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    for (const k of ['work_dir', 'workDir', 'cwd', 'working_directory']) {
      if (typeof s[k] === 'string') return s[k] as string;
    }
  } catch {
    /* absent */
  }
  return undefined;
}

export function createKimiWatcher(home = os.homedir()): FileSessionWatcher {
  const kimiHome = process.env.KIMI_SHARE_DIR || path.join(home, '.kimi');
  const legacyRoot = path.join(kimiHome, 'sessions');
  const codeRoot = path.join(
    process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'),
    'sessions',
  );
  const workDirs = new KimiWorkDirs(path.join(kimiHome, 'kimi.json'));
  const list = (lister: DirLister): string[] => {
    const out: string[] = [];
    for (const bucket of lister.dirs(legacyRoot)) {
      for (const session of lister.dirs(bucket)) {
        out.push(...lister.files(session, (n) => n === 'wire.jsonl'));
      }
    }
    for (const bucket of lister.dirs(codeRoot)) {
      for (const session of lister.dirs(bucket)) {
        out.push(...lister.files(path.join(session, 'agents', 'main'), (n) => n === 'wire.jsonl'));
      }
    }
    return out;
  };
  return new FileSessionWatcher({
    providerId: 'kimi',
    listFiles: list,
    createParser: (file) => {
      const isCode = file.startsWith(codeRoot);
      const sessionDir = isCode
        ? path.dirname(path.dirname(path.dirname(file)))
        : path.dirname(file);
      const bucket = path.basename(path.dirname(sessionDir));
      const cwd = workDirs.resolve(bucket) ?? cwdFromStateJson(sessionDir);
      return new KimiWireParser(path.basename(sessionDir), cwd);
    },
    sessionIdFromPath: (file) =>
      path.basename(
        file.startsWith(codeRoot)
          ? path.dirname(path.dirname(path.dirname(file)))
          : path.dirname(file),
      ),
  });
}
