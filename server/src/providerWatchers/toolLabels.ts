/**
 * Provider-agnostic tool normalization: maps each agent's own tool vocabulary
 * onto the Claude names the office already animates (Bash/Edit/Write types,
 * Read/Grep/Glob/WebFetch/WebSearch read), and builds the activity label in the
 * same wording the Claude provider uses ("Running: npm test", "Editing foo.ts",
 * "Reading bar.ts").
 */

import * as path from 'path';

import {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../constants.js';

type Canonical =
  | 'Bash'
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'Grep'
  | 'Glob'
  | 'WebFetch'
  | 'WebSearch'
  | 'Plan'
  | 'Ask'
  | 'Subtask';

/** Lower-cased, separator-free provider tool names → canonical kind. */
const TOOL_ALIASES: Record<string, Canonical> = {
  // shell
  bash: 'Bash',
  shell: 'Bash',
  shellcommand: 'Bash',
  localshell: 'Bash',
  containerexec: 'Bash',
  execcommand: 'Bash',
  runshellcommand: 'Bash',
  runterminalcmd: 'Bash',
  runcommand: 'Bash',
  powershell: 'Bash',
  terminal: 'Bash',
  // read
  read: 'Read',
  readfile: 'Read',
  readmanyfiles: 'Read',
  view: 'Read',
  viewimage: 'Read',
  cat: 'Read',
  // edit
  edit: 'Edit',
  multiedit: 'Edit',
  replace: 'Edit',
  strreplace: 'Edit',
  strreplacefile: 'Edit',
  strreplaceeditor: 'Edit',
  strreplacebasededittool: 'Edit',
  applypatch: 'Edit',
  patch: 'Edit',
  editfile: 'Edit',
  searchreplace: 'Edit',
  notebookedit: 'Edit',
  // write
  write: 'Write',
  writefile: 'Write',
  create: 'Write',
  createfile: 'Write',
  // search
  grep: 'Grep',
  grepsearch: 'Grep',
  searchfilecontent: 'Grep',
  codebasesearch: 'Grep',
  search: 'Grep',
  ripgrep: 'Grep',
  glob: 'Glob',
  globfilesearch: 'Glob',
  filesearch: 'Glob',
  listdirectory: 'Glob',
  listdir: 'Glob',
  ls: 'Glob',
  list: 'Glob',
  // web
  webfetch: 'WebFetch',
  fetch: 'WebFetch',
  fetchurl: 'WebFetch',
  webrun: 'WebFetch',
  websearch: 'WebSearch',
  googlewebsearch: 'WebSearch',
  searchweb: 'WebSearch',
  // planning / asking / delegating
  todowrite: 'Plan',
  updateplan: 'Plan',
  settodolist: 'Plan',
  updatetopic: 'Plan',
  enterplanmode: 'Plan',
  exitplanmode: 'Plan',
  question: 'Ask',
  askuserquestion: 'Ask',
  requestuserinput: 'Ask',
  requestuserinputasync: 'Ask',
  askuser: 'Ask',
  task: 'Subtask',
  agent: 'Subtask',
  invokeagent: 'Subtask',
  spawnagent: 'Subtask',
};

function aliasKey(name: string): string {
  // Strip an MCP/namespace prefix ("functions.shell", "default_api:read_file").
  const last = name.split(/[.:/]/).pop() ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Canonical kind for a provider tool name, or undefined when unknown. */
export function canonicalToolKind(rawName: string): Canonical | undefined {
  return TOOL_ALIASES[aliasKey(rawName)];
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Parse tool arguments that may arrive as an object or a JSON string. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* not JSON */
    }
  }
  return {};
}

const PATH_KEYS = [
  'file_path',
  'filePath',
  'absolute_path',
  'path',
  'file',
  'target_file',
  'targetFile',
  'filename',
  'notebook_path',
];

/** The file a tool call operates on, from the common argument spellings. */
export function pathArg(args: Record<string, unknown>): string | undefined {
  for (const k of PATH_KEYS) {
    const v = str(args[k]);
    if (v) return v;
  }
  const paths = args.paths ?? args.file_paths;
  if (Array.isArray(paths) && typeof paths[0] === 'string') return paths[0];
  return undefined;
}

/** basename that handles both separators regardless of host platform. */
export function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  return path.win32.basename(trimmed);
}

const SHELL_WRAPPERS = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

/** Command text from `command` / `cmd` (string or argv array). argv arrays
 *  that wrap a shell (`["bash","-lc","npm test"]`) yield the inner script. */
export function commandArg(args: Record<string, unknown>): string | undefined {
  const raw = args.command ?? args.cmd ?? args.commandLine ?? args.script;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
    const argv = raw as string[];
    if (argv.length >= 2 && SHELL_WRAPPERS.has(baseName(argv[0]).toLowerCase())) {
      return argv[argv.length - 1];
    }
    return argv.join(' ');
  }
  return undefined;
}

const READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'type',
  'get-content',
  'gc',
  'nl',
  'bat',
]);
const SEARCH_COMMANDS = new Set([
  'rg',
  'grep',
  'egrep',
  'findstr',
  'select-string',
  'sls',
  'ag',
  'ack',
]);
const LIST_COMMANDS = new Set(['ls', 'dir', 'get-childitem', 'gci', 'find', 'fd', 'tree']);

/** Classify a shell command line into a canonical tool + label. Reads and
 *  searches done through the shell animate as reading, like Claude's Read/Grep. */
export function shellTool(command: string): { name: string; status: string } {
  // Drop leading `cd dir && ` / `cd dir; ` prefixes: they say nothing.
  const effective = command.replace(/^\s*(?:cd\s+[^;&|]+(?:&&|;)\s*)+/i, '').trim();
  const words = effective.split(/\s+/);
  const first = baseName(words[0] ?? '')
    .toLowerCase()
    .replace(/\.exe$/, '');
  if (first === 'sed' && words.includes('-n')) {
    const file = [...words].reverse().find((w) => !w.startsWith('-') && !/^['"]?\d/.test(w));
    return { name: 'Read', status: `Reading ${file ? baseName(stripQuotes(file)) : 'file'}` };
  }
  if (READ_COMMANDS.has(first)) {
    const file = [...words.slice(1)].reverse().find((w) => !w.startsWith('-'));
    return {
      name: 'Read',
      status: file ? `Reading ${baseName(stripQuotes(file))}` : 'Reading file',
    };
  }
  if (SEARCH_COMMANDS.has(first) || (first === 'git' && words[1] === 'grep')) {
    return { name: 'Grep', status: 'Searching code' };
  }
  if (LIST_COMMANDS.has(first)) {
    return { name: 'Glob', status: 'Searching files' };
  }
  const shown = effective || command;
  return {
    name: 'Bash',
    status: `Running: ${truncate(shown, BASH_COMMAND_DISPLAY_MAX_LENGTH)}`,
  };
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`;]$/g, '');
}

/**
 * Build the canonical tool name + activity label for one provider tool call.
 * `rawName` is the provider's own tool name; `args` its parsed arguments.
 */
export function describeTool(
  rawName: string,
  args: Record<string, unknown>,
): { name: string; status: string } {
  const kind = canonicalToolKind(rawName);
  const file = pathArg(args);
  const fileBase = file ? baseName(file) : undefined;
  switch (kind) {
    case 'Bash': {
      const cmd = commandArg(args);
      return cmd ? shellTool(cmd) : { name: 'Bash', status: 'Running command' };
    }
    case 'Read':
      return { name: 'Read', status: fileBase ? `Reading ${fileBase}` : 'Reading file' };
    case 'Edit':
      return { name: 'Edit', status: fileBase ? `Editing ${fileBase}` : 'Editing files' };
    case 'Write':
      return { name: 'Write', status: fileBase ? `Writing ${fileBase}` : 'Writing file' };
    case 'Grep':
      return { name: 'Grep', status: 'Searching code' };
    case 'Glob':
      return { name: 'Glob', status: 'Searching files' };
    case 'WebFetch':
      return { name: 'WebFetch', status: 'Fetching web content' };
    case 'WebSearch':
      return { name: 'WebSearch', status: 'Searching the web' };
    case 'Plan':
      return { name: safeName(rawName), status: 'Planning' };
    case 'Ask':
      return { name: safeName(rawName), status: 'Waiting for your answer' };
    case 'Subtask': {
      // Deliberately NOT 'Task'/'Agent': those names make the office spawn a
      // Subtask sub-character that only the Claude sub-agent protocol clears.
      const desc =
        str(args.description) ?? str(args.task_name) ?? str(args.agent_name) ?? str(args.name);
      return {
        name: 'Subtask',
        status: desc
          ? `Subtask: ${truncate(desc, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH)}`
          : 'Running subtask',
      };
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(rawName);
      if (mcp) return { name: safeName(rawName), status: `Using ${mcp[1]}: ${mcp[2]}` };
      return { name: safeName(rawName), status: `Using ${rawName}` };
    }
  }
}

/** The office creates a Subtask sub-character for Claude's sub-agent tool names
 *  ('Task', 'Agent'), which only the Claude sub-agent protocol ever clears. A
 *  watched tool must never carry one of those names. */
function safeName(rawName: string): string {
  return rawName === 'Task' || rawName === 'Agent' ? 'Subtask' : rawName;
}

/**
 * Label for a unified-diff style patch (Codex apply_patch, "*** Begin Patch"):
 * "Editing foo.ts" for the first file, "Writing foo.ts" when it is added.
 */
export function patchTool(patchText: string): { name: string; status: string } | undefined {
  const m = /\*\*\* (Update|Add|Delete) File: ([^\r\n]+)/.exec(patchText);
  if (!m) return undefined;
  const file = baseName(m[2].trim());
  if (m[1] === 'Add') return { name: 'Write', status: `Writing ${file}` };
  if (m[1] === 'Delete') return { name: 'Edit', status: `Deleting ${file}` };
  return { name: 'Edit', status: `Editing ${file}` };
}
