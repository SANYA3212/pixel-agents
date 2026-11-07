import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_WATCH_ACTIVE_WINDOW_MS,
  PROVIDER_WATCH_FULL_READ_MAX_BYTES,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
} from '../src/constants.js';
import { createCodexWatcher } from '../src/providerWatchers/codex.js';
import { createCopilotWatcher } from '../src/providerWatchers/copilot.js';
import { CursorWatcher } from '../src/providerWatchers/cursor.js';
import { createGeminiWatchers } from '../src/providerWatchers/gemini.js';
import { createDefaultProviderWatchers } from '../src/providerWatchers/index.js';
import { createKimiWatcher } from '../src/providerWatchers/kimi.js';
import { OpenCodeWatcher } from '../src/providerWatchers/opencode.js';
import { createQwenWatchers } from '../src/providerWatchers/qwen.js';
import { loadSqlite } from '../src/providerWatchers/sqlite.js';

/** All data is synthetic, written into a temp HOME. */
const j = (o: unknown) => JSON.stringify(o) + '\n';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-watch-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function setMtime(file: string, ms: number): void {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

const meta = j({
  type: 'session_meta',
  payload: { id: 'th-1', cwd: '/work/repo', originator: 'codex_cli_rs' },
});

describe('FileSessionWatcher (Codex rollouts)', () => {
  const rollout = () =>
    path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '01',
      '02',
      'rollout-2026-01-02T10-00-00-th-1.jsonl',
    );

  it('no-ops while the data dir is missing, then picks it up once it appears', () => {
    const w = createCodexWatcher(home);
    expect(w.poll(Date.now())).toEqual([]);
    write(rollout(), meta);
    // A brand-new file is found at once (its directory listing changed).
    const snaps = w.poll(Date.now() + 1);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      providerId: 'codex',
      sessionId: 'th-1',
      cwd: '/work/repo',
      state: 'waiting',
    });
  });

  it('reads appended lines incrementally, carrying a partial last line', () => {
    const file = write(rollout(), meta);
    const w = createCodexWatcher(home);
    const t = Date.now();
    expect(w.poll(t)[0].state).toBe('waiting');

    fs.appendFileSync(file, j({ type: 'event_msg', payload: { type: 'task_started' } }));
    const half = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        call_id: 'c1',
        arguments: '{"command":"npm test"}',
      },
    });
    fs.appendFileSync(file, half.slice(0, 20));
    let s = w.poll(t + 1000)[0];
    expect(s).toMatchObject({ state: 'active', tools: [] });

    fs.appendFileSync(file, half.slice(20) + '\n');
    s = w.poll(t + 2000)[0];
    expect(s.tools).toEqual([{ id: 'c1', name: 'Bash', status: 'Running: npm test' }]);

    fs.appendFileSync(file, j({ type: 'event_msg', payload: { type: 'task_complete' } }));
    s = w.poll(t + 3000)[0];
    expect(s).toMatchObject({ state: 'waiting', tools: [] });
  });

  it('ignores sessions idle longer than the adoption window, drops quiet ones', () => {
    const file = write(rollout(), meta);
    const now = Date.now();
    setMtime(file, now - PROVIDER_WATCH_ACTIVE_WINDOW_MS - 60_000);
    const w = createCodexWatcher(home);
    expect(w.poll(now)).toEqual([]);

    // Fresh activity on an old file is found by the next full rescan.
    fs.appendFileSync(file, j({ type: 'event_msg', payload: { type: 'task_started' } }));
    const later = now + 31_000;
    setMtime(file, later - 1000);
    expect(w.poll(later)).toHaveLength(1);
    // ...and is dropped once quiet past the removal window.
    expect(w.poll(later + PROVIDER_WATCH_REMOVE_AFTER_MS + 5000)).toEqual([]);
  });

  it('reads head + tail of a large rollout', () => {
    const filler = j({
      type: 'response_item',
      payload: { type: 'reasoning', summary: [], encrypted_content: 'x'.repeat(2000) },
    });
    const body = filler.repeat(Math.ceil((PROVIDER_WATCH_FULL_READ_MAX_BYTES + 1) / filler.length));
    write(
      rollout(),
      meta +
        j({ type: 'event_msg', payload: { type: 'task_started' } }) +
        body +
        j({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            name: 'apply_patch',
            call_id: 'p',
            input: '*** Begin Patch\n*** Update File: z.ts\n',
          },
        }),
    );
    const s = createCodexWatcher(home).poll(Date.now())[0];
    expect(s).toMatchObject({ cwd: '/work/repo', sessionId: 'th-1', state: 'active' });
    expect(s.tools).toEqual([{ id: 'p', name: 'Edit', status: 'Editing z.ts' }]);
  });
});

describe('file-based provider layouts', () => {
  it('Gemini: tmp/<project>/chats with .project_root (JSONL and legacy JSON)', () => {
    const proj = path.join(home, '.gemini', 'tmp', 'myproj');
    write(path.join(proj, '.project_root'), '/work/gem\n');
    write(
      path.join(proj, 'chats', 'session-2026-01-01T10-00-abc.jsonl'),
      j({ sessionId: 'gem-1', projectHash: 'h' }) + j({ id: 'u', type: 'user', content: [] }),
    );
    write(
      path.join(proj, 'chats', 'session-2026-01-01T09-00-old.json'),
      JSON.stringify({ sessionId: 'gem-2', messages: [{ id: '1', type: 'gemini', content: 'x' }] }),
    );
    const snaps = createGeminiWatchers(home).flatMap((w) => w.poll(Date.now()));
    expect(snaps.map((s) => [s.sessionId, s.cwd, s.state]).sort()).toEqual([
      ['gem-1', '/work/gem', 'active'],
      ['gem-2', '/work/gem', 'waiting'],
    ]);
  });

  it('Qwen: projects/<cwd>/chats/<id>.jsonl', () => {
    write(
      path.join(home, '.qwen', 'projects', '-work-q', 'chats', 'q-1.jsonl'),
      j({ sessionId: 'q-1', type: 'user', cwd: '/work/q', message: { role: 'user', parts: [] } }),
    );
    const snaps = createQwenWatchers(home).flatMap((w) => w.poll(Date.now()));
    expect(snaps).toEqual([
      expect.objectContaining({
        providerId: 'qwen',
        sessionId: 'q-1',
        cwd: '/work/q',
        state: 'active',
      }),
    ]);
  });

  it('Kimi: sessions/<md5>/<id>/wire.jsonl with kimi.json work_dirs', () => {
    const cwd = '/work/kimi-proj';
    const bucket = crypto.createHash('md5').update(cwd).digest('hex');
    write(path.join(home, '.kimi', 'kimi.json'), JSON.stringify({ work_dirs: [{ path: cwd }] }));
    write(
      path.join(home, '.kimi', 'sessions', bucket, 'sess-k', 'wire.jsonl'),
      j({ timestamp: Date.now() / 1000, message: { type: 'TurnBegin', payload: {} } }),
    );
    const snaps = createKimiWatcher(home).poll(Date.now());
    expect(snaps).toEqual([expect.objectContaining({ sessionId: 'sess-k', cwd, state: 'active' })]);
  });

  it('Copilot: session-state/<id>/events.jsonl', () => {
    write(
      path.join(home, '.copilot', 'session-state', 'cp-9', 'events.jsonl'),
      j({ type: 'session.start', data: { context: { cwd: '/work/cp' } } }) +
        j({ type: 'user.message', data: {} }),
    );
    const snaps = createCopilotWatcher(home).poll(Date.now());
    expect(snaps).toEqual([
      expect.objectContaining({ sessionId: 'cp-9', cwd: '/work/cp', state: 'active' }),
    ]);
  });

  it('every default watcher is a silent no-op on an empty home', () => {
    const watchers = createDefaultProviderWatchers(home, undefined);
    expect(watchers.length).toBeGreaterThanOrEqual(7);
    for (const w of watchers) expect(w.poll(Date.now())).toEqual([]);
    for (const w of watchers) w.dispose();
    expect(createDefaultProviderWatchers(home, ['codex']).map((w) => w.providerId)).toEqual([
      'codex',
    ]);
  });
});

const sqlite = loadSqlite();

describe.skipIf(!sqlite)('OpenCodeWatcher (SQLite)', () => {
  function createDb(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new sqlite!.DatabaseSync(file);
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
        time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE INDEX smt ON session_message (time_created);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
        time_created INTEGER, time_updated INTEGER, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    `);
    return db;
  }

  it('reports 2.x and 1.x sessions and follows new messages', () => {
    const file = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    const db = createDb(file);
    const now = Date.now();
    db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?)').run(
      's2',
      'p',
      null,
      '/work/oc',
      'T',
      now,
      now,
      null,
    );
    const msg = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
    msg.run('m1', 's2', 'user', 1, now, now, JSON.stringify({ text: 'synthetic' }));
    msg.run(
      'm2',
      's2',
      'assistant',
      2,
      now + 1,
      now + 1,
      JSON.stringify({
        time: { created: now },
        content: [
          {
            type: 'tool',
            id: 't1',
            name: 'grep',
            state: { status: 'running', input: { pattern: 'x' } },
          },
        ],
      }),
    );
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?)').run(
      's1',
      'p',
      null,
      '/work/old',
      'T',
      now,
      now,
      null,
    );
    db.prepare('INSERT INTO message VALUES (?,?,?,?,?)').run(
      'a',
      's1',
      now,
      now,
      JSON.stringify({ role: 'assistant', time: { created: now, completed: now }, finish: 'stop' }),
    );

    const w = new OpenCodeWatcher(file);
    let snaps = w.poll(now + 100);
    const v2 = snaps.find((s) => s.sessionId === 's2');
    expect(v2).toMatchObject({
      providerId: 'opencode',
      cwd: '/work/oc',
      state: 'active',
      tools: [{ id: 't1', name: 'Grep' }],
    });
    expect(snaps.find((s) => s.sessionId === 's1')).toMatchObject({
      cwd: '/work/old',
      state: 'waiting',
    });

    msg.run('m3', 's2', 'system', 3, now + 2, now + 2, '{}'); // bookkeeping: ignored
    msg.run('m4', 's2', 'idle', 4, now + 3, now + 3, JSON.stringify({ outcome: 'succeeded' }));
    snaps = w.poll(now + 200);
    expect(snaps.find((s) => s.sessionId === 's2')).toMatchObject({ state: 'waiting', tools: [] });

    db.prepare('UPDATE session_v2 SET time_archived = ? WHERE id = ?').run(now + 4, 's2');
    msg.run('m5', 's2', 'user', 5, now + 5, now + 5, '{}');
    snaps = w.poll(now + 300);
    expect(snaps.find((s) => s.sessionId === 's2')?.state).toBe('ended');
    w.dispose();
    db.close();
  });

  it('is a no-op when the database does not exist', () => {
    const w = new OpenCodeWatcher(path.join(home, 'nope', 'opencode.db'));
    expect(w.poll(Date.now())).toEqual([]);
  });
});

describe.skipIf(!sqlite)('CursorWatcher (store.db per chat)', () => {
  it('reads meta + newest message blobs read-only', () => {
    const dbFile = path.join(home, '.cursor', 'chats', 'bucket', 'chat-1', 'store.db');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const db = new sqlite!.DatabaseSync(dbFile);
    db.exec(
      'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);',
    );
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      '0',
      Buffer.from(
        JSON.stringify({ agentId: 'chat-1', name: 'N', workspacePath: '/work/cur' }),
      ).toString('hex'),
    );
    const blob = db.prepare('INSERT INTO blobs VALUES (?, ?)');
    blob.run('b0', Buffer.from([0x0a, 0x02, 0x08, 0x01])); // protobuf turn state: skipped
    blob.run('b1', Buffer.from(JSON.stringify({ role: 'user', content: 'synthetic' })));
    blob.run(
      'b2',
      Buffer.from(
        JSON.stringify({
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c', toolName: 'Read', args: { path: 'a/b.c' } },
          ],
        }),
      ),
    );
    db.close();

    const snaps = new CursorWatcher(path.join(home, '.cursor', 'chats')).poll(Date.now());
    expect(snaps).toEqual([
      expect.objectContaining({
        providerId: 'cursor',
        sessionId: 'chat-1',
        cwd: '/work/cur',
        state: 'active',
        tools: [{ id: 'c', name: 'Read', status: 'Reading b.c' }],
      }),
    ]);
  });
});
