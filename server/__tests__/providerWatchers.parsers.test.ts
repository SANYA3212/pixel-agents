import { describe, expect, it } from 'vitest';

import {
  codexCodeModeTool,
  codexFunctionTool,
  CodexSessionParser,
} from '../src/providerWatchers/codex.js';
import { CopilotEventsParser } from '../src/providerWatchers/copilot.js';
import { cursorState, decodeCursorMeta } from '../src/providerWatchers/cursor.js';
import { GeminiChatParser } from '../src/providerWatchers/gemini.js';
import { KimiWireParser } from '../src/providerWatchers/kimi.js';
import { openCodeV1State, openCodeV2State } from '../src/providerWatchers/opencode.js';
import { QwenSessionParser } from '../src/providerWatchers/qwen.js';
import { describeTool, patchTool, shellTool } from '../src/providerWatchers/toolLabels.js';

/** Synthetic fixtures only: every record below is invented, shaped like the
 *  provider's format, and carries no real session content. */
const j = (o: unknown) => JSON.stringify(o);
const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString();

describe('toolLabels', () => {
  it('labels shell commands like the Claude provider, reads/searches as reading', () => {
    expect(shellTool('npm test')).toEqual({ name: 'Bash', status: 'Running: npm test' });
    expect(shellTool('cd /repo && npm run build')).toEqual({
      name: 'Bash',
      status: 'Running: npm run build',
    });
    expect(shellTool('cat src/bar.ts')).toEqual({ name: 'Read', status: 'Reading bar.ts' });
    expect(shellTool('Get-Content C:\\x\\foo.md')).toEqual({
      name: 'Read',
      status: 'Reading foo.md',
    });
    expect(shellTool("sed -n '1,40p' lib/a.py")).toEqual({ name: 'Read', status: 'Reading a.py' });
    expect(shellTool('rg -n needle src')).toEqual({ name: 'Grep', status: 'Searching code' });
    expect(shellTool('ls -la')).toEqual({ name: 'Glob', status: 'Searching files' });
    expect(shellTool('x'.repeat(80)).status.endsWith('\u2026')).toBe(true);
  });

  it('maps every provider vocabulary onto canonical tools', () => {
    expect(describeTool('read_file', { file_path: '/a/b/foo.ts' })).toEqual({
      name: 'Read',
      status: 'Reading foo.ts',
    });
    expect(describeTool('StrReplaceFile', { path: 'x/y.rs' })).toEqual({
      name: 'Edit',
      status: 'Editing y.rs',
    });
    expect(describeTool('write', { filePath: 'C:\\p\\z.json' })).toEqual({
      name: 'Write',
      status: 'Writing z.json',
    });
    expect(describeTool('run_shell_command', { command: 'make' })).toEqual({
      name: 'Bash',
      status: 'Running: make',
    });
    expect(describeTool('Shell', { command: ['bash', '-lc', 'pytest -q'] })).toEqual({
      name: 'Bash',
      status: 'Running: pytest -q',
    });
    expect(describeTool('google_web_search', {}).name).toBe('WebSearch');
    expect(describeTool('FetchURL', {}).name).toBe('WebFetch');
    expect(describeTool('mcp__srv__do_thing', {}).status).toBe('Using srv: do_thing');
  });

  it("never emits Claude's sub-agent tool names (they spawn Subtask characters)", () => {
    expect(describeTool('Task', { description: 'look around' })).toEqual({
      name: 'Subtask',
      status: 'Subtask: look around',
    });
    expect(describeTool('Agent', {}).name).toBe('Subtask');
    expect(describeTool('task', {}).name).toBe('Subtask');
  });

  it('labels patches by their first file', () => {
    expect(patchTool('*** Begin Patch\n*** Update File: src/app.js\n@@')).toEqual({
      name: 'Edit',
      status: 'Editing app.js',
    });
    expect(patchTool('*** Begin Patch\n*** Add File: new.md\n+x')).toEqual({
      name: 'Write',
      status: 'Writing new.md',
    });
    expect(patchTool('no patch here')).toBeUndefined();
  });
});

describe('Codex rollout parser', () => {
  const meta = (extra: Record<string, unknown> = {}) =>
    j({
      timestamp: ts(0),
      type: 'session_meta',
      payload: {
        id: 'thread-1',
        session_id: 'sess-1',
        cwd: '/work/my-repo',
        originator: 'Codex Desktop',
        ...extra,
      },
    });

  it('tracks turns and code-mode tools', () => {
    const p = new CodexSessionParser();
    p.feedLine(meta());
    expect(p.state()).toMatchObject({
      sessionId: 'thread-1',
      cwd: '/work/my-repo',
      variant: 'Codex Desktop',
      state: 'waiting',
      tools: [],
    });

    p.feedLine(
      j({ timestamp: ts(1), type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } }),
    );
    expect(p.state().state).toBe('active');

    p.feedLine(
      j({
        timestamp: ts(2),
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'c1',
          input:
            'const r = await tools.exec_command({ cmd: "npm test", yield_time_ms: 1000 });\ntext(r);',
        },
      }),
    );
    expect(p.state().tools).toEqual([{ id: 'c1', name: 'Bash', status: 'Running: npm test' }]);

    p.feedLine(
      j({
        timestamp: ts(3),
        type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [] },
      }),
    );
    expect(p.state()).toMatchObject({ state: 'active', tools: [] });

    p.feedLine(
      j({
        timestamp: ts(4),
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell',
          call_id: 'c2',
          arguments: j({ command: ['bash', '-lc', 'cat README.md'] }),
        },
      }),
    );
    expect(p.state().tools).toEqual([{ id: 'c2', name: 'Read', status: 'Reading README.md' }]);

    p.feedLine(
      j({ timestamp: ts(5), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }),
    );
    expect(p.state()).toMatchObject({ state: 'waiting', tools: [] });
    expect(p.state().lastEventAt).toBe(Date.parse(ts(5)));
  });

  it('understands turn_aborted, legacy exec events and turn_context cwd', () => {
    const p = new CodexSessionParser();
    p.feedLine(meta({ originator: 'codex_cli_rs' }));
    expect(p.state().variant).toBeUndefined();
    p.feedLine(j({ type: 'turn_context', payload: { cwd: '/work/other' } }));
    p.feedLine(
      j({
        type: 'event_msg',
        payload: { type: 'exec_command_begin', call_id: 'e1', command: ['ls'] },
      }),
    );
    expect(p.state()).toMatchObject({
      cwd: '/work/other',
      state: 'active',
      tools: [{ id: 'e1', name: 'Glob' }],
    });
    p.feedLine(j({ type: 'event_msg', payload: { type: 'exec_command_end', call_id: 'e1' } }));
    expect(p.state().tools).toEqual([]);
    p.feedLine(j({ type: 'event_msg', payload: { type: 'turn_aborted', reason: 'interrupted' } }));
    expect(p.state().state).toBe('waiting');
  });

  it('labels sub-agent threads by nickname and survives junk lines', () => {
    const p = new CodexSessionParser();
    p.feedLine('{not json');
    p.feedLine(
      meta({
        source: { subagent: { thread_spawn: { parent_thread_id: 'p', agent_nickname: 'Kuhn' } } },
      }),
    );
    expect(p.state().labelDetail).toBe('Kuhn');
  });

  it('labels code-mode cells and classic function calls', () => {
    expect(
      codexCodeModeTool('await tools.apply_patch(`*** Begin Patch\n*** Update File: a/b.ts\n`)'),
    ).toEqual({
      name: 'Edit',
      status: 'Editing b.ts',
    });
    expect(codexCodeModeTool('await tools.web__run({ search_query: [{ q: "x" }] })').name).toBe(
      'WebSearch',
    );
    expect(codexCodeModeTool('await tools.web__run({ open: [{ ref_id: "x" }] })').name).toBe(
      'WebFetch',
    );
    expect(codexCodeModeTool('await tools.exec_command({ cmd })').status).toBe('Running command');
    expect(codexCodeModeTool('const x = 1 + 1;')).toEqual({ name: 'Bash', status: 'Running code' });
    expect(
      codexFunctionTool('wait', '{}', { name: 'Bash', status: 'Running: npm test' }).status,
    ).toBe('Running: npm test');
    expect(codexFunctionTool('exec_command', j({ cmd: 'git status' })).status).toBe(
      'Running: git status',
    );
  });
});

describe('Gemini chat parser', () => {
  it('reads the JSONL record stream (header, $set, re-appended messages)', () => {
    const p = new GeminiChatParser('/work/g');
    p.feedLine(j({ sessionId: 'g-1', projectHash: 'h', startTime: ts(0), lastUpdated: ts(0) }));
    p.feedLine(j({ id: 'u1', timestamp: ts(1), type: 'user', content: [{ text: 'synthetic' }] }));
    expect(p.state()).toMatchObject({ sessionId: 'g-1', cwd: '/work/g', state: 'active' });
    p.feedLine(j({ $set: { lastUpdated: ts(2) } }));
    p.feedLine(
      j({
        id: 'm1',
        timestamp: ts(3),
        type: 'gemini',
        content: '',
        toolCalls: [
          {
            id: 'tc1',
            name: 'run_shell_command',
            args: { command: 'npm test' },
            status: 'executing',
          },
        ],
      }),
    );
    expect(p.state().tools).toEqual([{ id: 'tc1', name: 'Bash', status: 'Running: npm test' }]);
    // Same id re-appended once the call completed: still mid-turn, tool done.
    p.feedLine(
      j({
        id: 'm1',
        timestamp: ts(4),
        type: 'gemini',
        toolCalls: [
          {
            id: 'tc1',
            name: 'run_shell_command',
            args: { command: 'npm test' },
            status: 'success',
          },
        ],
      }),
    );
    expect(p.state()).toMatchObject({ state: 'active', tools: [] });
    p.feedLine(j({ id: 'm2', timestamp: ts(5), type: 'gemini', content: 'done' }));
    expect(p.state()).toMatchObject({ state: 'waiting', tools: [] });
  });

  it('takes cwd from the header when no .project_root, ends finished sub-agents', () => {
    const p = new GeminiChatParser();
    p.feedLine(j({ sessionId: 's', kind: 'subagent', directories: ['/work/sub'] }));
    p.feedLine(
      j({
        id: 'm',
        type: 'gemini',
        toolCalls: [{ id: 'x', name: 'complete_task', args: {}, status: 'success' }],
      }),
    );
    expect(p.state()).toMatchObject({ cwd: '/work/sub', labelDetail: 'subagent', state: 'ended' });
  });

  it('reads the older single-document JSON format', () => {
    const p = new GeminiChatParser();
    p.feedDocument({
      sessionId: 'old',
      lastUpdated: ts(9),
      messages: [
        { id: '1', type: 'user', content: 'synthetic' },
        {
          id: '2',
          type: 'gemini',
          toolCalls: [
            { id: 'r', name: 'read_file', args: { absolute_path: '/x/y.md' }, status: 'scheduled' },
          ],
        },
      ],
    });
    expect(p.state()).toMatchObject({
      sessionId: 'old',
      state: 'active',
      tools: [{ id: 'r', name: 'Read', status: 'Reading y.md' }],
      lastEventAt: Date.parse(ts(9)),
    });
  });
});

describe('Qwen Code parser', () => {
  it('follows user / assistant functionCall / tool_result records', () => {
    const p = new QwenSessionParser();
    p.feedLine(
      j({
        uuid: 'a',
        sessionId: 'q-1',
        timestamp: ts(0),
        type: 'user',
        cwd: '/work/q',
        message: { role: 'user', parts: [{ text: 'synthetic' }] },
      }),
    );
    expect(p.state()).toMatchObject({ sessionId: 'q-1', cwd: '/work/q', state: 'active' });
    p.feedLine(
      j({
        uuid: 'b',
        sessionId: 'q-1',
        type: 'assistant',
        message: {
          role: 'model',
          parts: [
            { functionCall: { id: 'f1', name: 'edit', args: { file_path: '/work/q/m.ts' } } },
          ],
        },
      }),
    );
    expect(p.state().tools).toEqual([{ id: 'f1', name: 'Edit', status: 'Editing m.ts' }]);
    p.feedLine(
      j({
        uuid: 'c',
        type: 'tool_result',
        message: { role: 'user', parts: [{ functionResponse: { id: 'f1', name: 'edit' } }] },
      }),
    );
    expect(p.state()).toMatchObject({ state: 'active', tools: [] });
    p.feedLine(j({ uuid: 'd', type: 'system', subtype: 'ui_telemetry' }));
    p.feedLine(
      j({
        uuid: 'e',
        type: 'assistant',
        message: { role: 'model', parts: [{ text: 'synthetic' }] },
      }),
    );
    expect(p.state()).toMatchObject({ state: 'waiting', tools: [] });
  });
});

describe('Kimi wire parser', () => {
  it('maps Wire events to turn state and tools', () => {
    const p = new KimiWireParser('k-1', '/work/k');
    p.feedLine(j({ type: 'metadata', protocol_version: '1' }));
    p.feedLine(
      j({
        timestamp: 1767268800.5,
        message: { type: 'TurnBegin', payload: { user_input: 'synthetic' } },
      }),
    );
    expect(p.state()).toMatchObject({
      sessionId: 'k-1',
      cwd: '/work/k',
      state: 'active',
      lastEventAt: 1767268800500,
    });
    p.feedLine(
      j({
        message: {
          type: 'ToolCall',
          payload: {
            type: 'function',
            id: 'k1',
            function: { name: 'ReadFile', arguments: j({ path: 'src/k.py' }) },
          },
        },
      }),
    );
    expect(p.state().tools).toEqual([{ id: 'k1', name: 'Read', status: 'Reading k.py' }]);
    p.feedLine(
      j({ message: { type: 'ToolResult', payload: { tool_call_id: 'k1', return_value: {} } } }),
    );
    expect(p.state().tools).toEqual([]);
    p.feedLine(j({ message: { type: 'TurnEnd', payload: {} } }));
    expect(p.state().state).toBe('waiting');
  });
});

describe('Copilot CLI events parser', () => {
  it('tracks session.start cwd, tool execution and turn end', () => {
    const p = new CopilotEventsParser();
    p.feedLine(
      j({
        type: 'session.start',
        id: '1',
        timestamp: ts(0),
        data: { sessionId: 'cp-1', context: { cwd: '/work/c' } },
      }),
    );
    expect(p.state()).toMatchObject({ sessionId: 'cp-1', cwd: '/work/c', state: 'waiting' });
    p.feedLine(j({ type: 'user.message', data: { content: 'synthetic' } }));
    p.feedLine(
      j({
        type: 'assistant.message',
        data: { toolRequests: [{ toolCallId: 't1', name: 'bash' }] },
      }),
    );
    p.feedLine(
      j({
        type: 'tool.execution_start',
        data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'go test ./...' } },
      }),
    );
    expect(p.state().tools).toEqual([{ id: 't1', name: 'Bash', status: 'Running: go test ./...' }]);
    p.feedLine(j({ type: 'tool.execution_complete', data: { toolCallId: 't1', success: true } }));
    p.feedLine(j({ type: 'assistant.turn_end', data: {} }));
    // The last assistant message asked for tools: another step follows.
    expect(p.state().state).toBe('active');
    p.feedLine(j({ type: 'assistant.message', data: { content: 'synthetic' } }));
    p.feedLine(j({ type: 'assistant.turn_end', data: {} }));
    expect(p.state().state).toBe('waiting');
    p.feedLine(j({ type: 'session.shutdown', data: {} }));
    expect(p.state().state).toBe('ended');
  });
});

describe('OpenCode message state', () => {
  it('2.x: idle / user / assistant with running tools / finish', () => {
    expect(openCodeV2State('idle', {}).state).toBe('waiting');
    expect(openCodeV2State('user', {}).state).toBe('active');
    expect(
      openCodeV2State('assistant', {
        time: { created: 1 },
        content: [
          { type: 'reasoning', text: 'x' },
          {
            type: 'tool',
            id: 'o1',
            name: 'bash',
            state: { status: 'running', input: { command: 'cargo build' } },
          },
          {
            type: 'tool',
            id: 'o2',
            name: 'read',
            state: { status: 'completed', input: { filePath: 'a.ts' } },
          },
        ],
      }),
    ).toEqual({
      state: 'active',
      tools: [{ id: 'o1', name: 'Bash', status: 'Running: cargo build' }],
    });
    expect(
      openCodeV2State('assistant', { time: { created: 1, completed: 2 }, finish: 'tool-calls' })
        .state,
    ).toBe('active');
    expect(
      openCodeV2State('assistant', { time: { created: 1, completed: 2 }, finish: 'stop' }).state,
    ).toBe('waiting');
  });

  it('1.x: message role + tool parts', () => {
    expect(openCodeV1State({ role: 'user' }, []).state).toBe('active');
    expect(
      openCodeV1State({ role: 'assistant', time: { created: 1 } }, [
        {
          type: 'tool',
          callID: 'p1',
          tool: 'edit',
          state: { status: 'pending', input: { filePath: '/x/e.go' } },
        },
      ]),
    ).toEqual({ state: 'active', tools: [{ id: 'p1', name: 'Edit', status: 'Editing e.go' }] });
    expect(
      openCodeV1State({ role: 'assistant', time: { created: 1, completed: 3 }, finish: 'stop' }, [])
        .state,
    ).toBe('waiting');
  });
});

describe('Cursor store decoding', () => {
  it('decodes hex or plain JSON meta', () => {
    const rec = { agentId: 'a', name: 'n', workspacePath: '/work/cur' };
    expect(decodeCursorMeta(Buffer.from(JSON.stringify(rec)).toString('hex'))).toEqual(rec);
    expect(decodeCursorMeta(JSON.stringify(rec))).toEqual(rec);
    expect(decodeCursorMeta('zz')).toBeUndefined();
  });

  it('derives state from the newest messages', () => {
    const call = {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Shell', args: { command: 'npm ci' } },
      ],
    };
    expect(cursorState([{ role: 'user', content: 'x' }])).toEqual({ state: 'active', tools: [] });
    expect(cursorState([{ role: 'user', content: 'x' }, call])).toEqual({
      state: 'active',
      tools: [{ id: 'c1', name: 'Bash', status: 'Running: npm ci' }],
    });
    expect(
      cursorState([call, { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1' }] }])
        .state,
    ).toBe('active');
    expect(cursorState([{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }]).state).toBe(
      'waiting',
    );
  });
});
