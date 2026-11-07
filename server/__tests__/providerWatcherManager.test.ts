import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { resendAgentActivity } from '../src/agentActivityResend.js';
import { agentCreatedMessage, agentProviderMeta } from '../src/agentCreatedMessage.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  characterSpritesMessage,
  loadExternalCharacterSprites,
  loadProviderSkins,
  mergeCharacterSprites,
} from '../src/assetLoader.js';
import {
  PROVIDER_WATCH_ACTIVE_STALE_MS,
  PROVIDER_WATCH_AGENT_ID_BASE,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
} from '../src/constants.js';
import {
  agentLabelFor,
  ProviderWatcherManager,
} from '../src/providerWatchers/providerWatcherManager.js';
import type { ProviderWatcher, WatchedSessionSnapshot } from '../src/providerWatchers/types.js';
import type { PersistedAgent } from '../src/types.js';

class FakeWatcher implements ProviderWatcher {
  readonly providerId = 'codex' as const;
  snaps: WatchedSessionSnapshot[] = [];
  disposed = false;
  poll(): WatchedSessionSnapshot[] {
    return this.snaps;
  }
  dispose(): void {
    this.disposed = true;
  }
}

const T0 = 1_800_000_000_000;

function snap(over: Partial<WatchedSessionSnapshot> = {}): WatchedSessionSnapshot {
  return {
    providerId: 'codex',
    sessionId: 'sess-1',
    sourcePath: '/tmp/rollout.jsonl',
    cwd: '/work/my-repo',
    state: 'active',
    tools: [],
    lastActivity: T0,
    ...over,
  };
}

function setup(watchAll = true) {
  const store = new AgentStateStore();
  const watcher = new FakeWatcher();
  const created: Record<string, unknown>[] = [];
  const removed: number[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  store.on('agentAdded', (id, agent) => created.push(agentCreatedMessage(id, agent)));
  store.on('agentRemoved', (id) => removed.push(id));
  store.on('broadcast', (m) => broadcasts.push(m));
  const watchAllSessions = { current: watchAll };
  const mgr = new ProviderWatcherManager({
    store,
    watchers: [watcher],
    watchAllSessions,
    scopeDirs: () => ['/work'],
  });
  return { store, watcher, mgr, created, removed, broadcasts, watchAllSessions };
}

describe('ProviderWatcherManager', () => {
  it('adopts an active session with its tool, as the Claude path would broadcast', () => {
    const { mgr, watcher, created, broadcasts, store } = setup();
    watcher.snaps = [snap({ tools: [{ id: 't1', name: 'Bash', status: 'Running: npm test' }] })];
    mgr.tick(T0);

    expect(created).toEqual([
      expect.objectContaining({
        type: 'agentCreated',
        id: PROVIDER_WATCH_AGENT_ID_BASE,
        isExternal: true,
        providerId: 'codex',
        agentLabel: 'Codex \u00b7 my-repo',
        directoryName: 'my-repo',
      }),
    ]);
    expect(broadcasts).toEqual([
      {
        type: 'agentToolStart',
        id: PROVIDER_WATCH_AGENT_ID_BASE,
        toolId: 't1',
        status: 'Running: npm test',
        toolName: 'Bash',
      },
      { type: 'agentStatus', id: PROVIDER_WATCH_AGENT_ID_BASE, status: 'active' },
    ]);
    const agent = store.get(PROVIDER_WATCH_AGENT_ID_BASE)!;
    expect(agent.providerWatched).toBe(true);
    expect(agent.terminalRef).toBeUndefined();
    expect(mgr.agentIdFor('codex', 'sess-1')).toBe(PROVIDER_WATCH_AGENT_ID_BASE);
  });

  it('diffs tools, then clears them and goes waiting at turn end', () => {
    const { mgr, watcher, broadcasts } = setup();
    const id = PROVIDER_WATCH_AGENT_ID_BASE;
    watcher.snaps = [snap({ tools: [{ id: 't1', name: 'Read', status: 'Reading a.ts' }] })];
    mgr.tick(T0);
    broadcasts.length = 0;

    watcher.snaps = [
      snap({
        lastActivity: T0 + 1000,
        tools: [{ id: 't2', name: 'Edit', status: 'Editing a.ts' }],
      }),
    ];
    mgr.tick(T0 + 1000);
    expect(broadcasts).toEqual([
      { type: 'agentToolDone', id, toolId: 't1' },
      { type: 'agentToolStart', id, toolId: 't2', status: 'Editing a.ts', toolName: 'Edit' },
    ]);
    broadcasts.length = 0;

    mgr.tick(T0 + 1500); // unchanged snapshot: silence
    expect(broadcasts).toEqual([]);

    watcher.snaps = [snap({ lastActivity: T0 + 2000, state: 'waiting' })];
    mgr.tick(T0 + 2000);
    expect(broadcasts).toEqual([
      { type: 'agentToolsClear', id },
      { type: 'agentStatus', id, status: 'waiting' },
    ]);
    broadcasts.length = 0;

    watcher.snaps = [snap({ lastActivity: T0 + 3000, state: 'active' })];
    mgr.tick(T0 + 3000);
    expect(broadcasts).toEqual([{ type: 'agentStatus', id, status: 'active' }]);
  });

  it('adopts a between-turns session quietly (no chime) and resends its state on connect', () => {
    const { mgr, watcher, broadcasts, store } = setup();
    watcher.snaps = [snap({ state: 'waiting' })];
    mgr.tick(T0);
    expect(broadcasts).toEqual([]);
    const sent: Record<string, unknown>[] = [];
    resendAgentActivity((m) => sent.push(m), store);
    expect(sent).toEqual([
      { type: 'agentStatus', id: PROVIDER_WATCH_AGENT_ID_BASE, status: 'waiting' },
    ]);
  });

  it('removes a session gone quiet, ended, or vanished from the watcher', () => {
    const { mgr, watcher, removed } = setup();
    watcher.snaps = [snap({ sessionId: 'a' }), snap({ sessionId: 'b' }), snap({ sessionId: 'c' })];
    mgr.tick(T0);
    watcher.snaps = [snap({ sessionId: 'a', state: 'ended' }), snap({ sessionId: 'b' })];
    mgr.tick(T0 + 1000);
    expect(removed.sort()).toEqual([
      PROVIDER_WATCH_AGENT_ID_BASE,
      PROVIDER_WATCH_AGENT_ID_BASE + 2,
    ]);
    mgr.tick(T0 + PROVIDER_WATCH_REMOVE_AFTER_MS + 1);
    expect(removed).toHaveLength(3);
  });

  it('shows a silent "active" turn without tools as waiting (process likely died)', () => {
    const { mgr, watcher, broadcasts } = setup();
    watcher.snaps = [snap()];
    mgr.tick(T0);
    broadcasts.length = 0;
    mgr.tick(T0 + PROVIDER_WATCH_ACTIVE_STALE_MS + 1);
    expect(broadcasts).toContainEqual({
      type: 'agentStatus',
      id: PROVIDER_WATCH_AGENT_ID_BASE,
      status: 'waiting',
    });
  });

  it('closing an agent hides it until the session shows NEW activity', () => {
    const { mgr, watcher, store, created } = setup();
    watcher.snaps = [snap()];
    mgr.tick(T0);
    // What closeAgent -> AgentRuntime.closeAgent -> removeAgent ends in.
    store.delete(PROVIDER_WATCH_AGENT_ID_BASE);
    mgr.tick(T0 + 1000);
    expect(store.size).toBe(0);
    watcher.snaps = [snap({ lastActivity: T0 + 2000 })];
    mgr.tick(T0 + 2000);
    expect(store.size).toBe(1);
    expect(created).toHaveLength(2);
    expect([...store.keys()][0]).not.toBe(PROVIDER_WATCH_AGENT_ID_BASE);
  });

  it('respects Watch All Sessions: off = only sessions inside the scope dirs', () => {
    const { mgr, watcher, store, watchAllSessions } = setup(false);
    watcher.snaps = [
      snap({ sessionId: 'in', cwd: '/work/inside' }),
      snap({ sessionId: 'out', cwd: '/elsewhere/x' }),
    ];
    mgr.tick(T0);
    expect([...store.values()].map((a) => a.sessionId)).toEqual(['in']);
    watchAllSessions.current = true;
    mgr.tick(T0 + 100);
    expect([...store.values()].map((a) => a.sessionId).sort()).toEqual(['in', 'out']);
    watchAllSessions.current = false;
    mgr.tick(T0 + 200);
    expect([...store.values()].map((a) => a.sessionId)).toEqual(['in']);
  });

  it('never persists watched agents (Claude agents still are)', () => {
    const store = new AgentStateStore();
    let saved: PersistedAgent[] = [];
    store.setAdapter({
      saveAgents: (a: PersistedAgent[]) => (saved = a),
    } as unknown as StateAdapter);
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        isExternal: true,
        projectDir: '/p',
        jsonlFile: '/p/s.jsonl',
      }),
    );
    store.set(
      2,
      createAgentState({
        id: 2,
        sessionId: 'x',
        isExternal: true,
        projectDir: '/w',
        jsonlFile: '/r.jsonl',
        providerWatched: true,
        providerId: 'codex',
      }),
    );
    store.persist();
    expect(saved.map((a) => a.id)).toEqual([1]);
  });

  it('stop() disposes watchers and stops listening', () => {
    const { mgr, watcher } = setup();
    mgr.stop();
    expect(watcher.disposed).toBe(true);
  });
});

describe('agent identity on the wire', () => {
  it("Claude agents carry providerId 'claude'; watched ones their own id + label", () => {
    const claude = createAgentState({
      id: 1,
      sessionId: 's',
      isExternal: false,
      projectDir: '/p',
      jsonlFile: '/p/s.jsonl',
    });
    expect(agentCreatedMessage(1, claude)).toMatchObject({
      type: 'agentCreated',
      id: 1,
      providerId: 'claude',
    });
    expect(agentProviderMeta(claude)).toEqual({ providerId: 'claude' });
    const codex = createAgentState({
      id: 2,
      sessionId: 'x',
      isExternal: true,
      projectDir: '/w',
      jsonlFile: '/r',
      providerId: 'codex',
      agentLabel: 'Codex \u00b7 w',
    });
    expect(agentProviderMeta(codex)).toEqual({ providerId: 'codex', agentLabel: 'Codex \u00b7 w' });
  });

  it('labels: variant, nickname, subagent, fallbacks', () => {
    expect(agentLabelFor(snap({ variant: 'Codex Desktop' }))).toBe('Codex Desktop \u00b7 my-repo');
    expect(agentLabelFor(snap({ labelDetail: 'Kuhn' }))).toBe('Codex \u00b7 Kuhn');
    expect(agentLabelFor(snap({ providerId: 'gemini', labelDetail: 'subagent' }))).toBe(
      'Gemini \u00b7 my-repo (subagent)',
    );
    expect(agentLabelFor(snap({ providerId: 'opencode', cwd: 'C:\\Users\\me\\proj' }))).toBe(
      'OpenCode \u00b7 proj',
    );
    expect(agentLabelFor(snap({ cwd: undefined, sessionId: 'abcdef123456' }))).toBe(
      'Codex \u00b7 abcdef12',
    );
  });
});

describe('provider skins', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-skins-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function png(file: string, width: number, height: number, rgb: [number, number, number]): void {
    const img = new PNG({ width, height });
    for (let i = 0; i < width * height; i++) {
      img.data[i * 4] = rgb[0];
      img.data[i * 4 + 1] = rgb[1];
      img.data[i * 4 + 2] = rgb[2];
      img.data[i * 4 + 3] = 255;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PNG.sync.write(img));
  }

  it('loads assets/characters/agents/<id>.png, skipping wrong-size files', () => {
    const dir = path.join(root, 'assets', 'characters', 'agents');
    png(path.join(dir, 'codex.png'), 112, 96, [255, 0, 0]);
    png(path.join(dir, 'tiny.png'), 16, 16, [0, 0, 0]);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    const skins = loadProviderSkins(root);
    expect(Object.keys(skins)).toEqual(['codex']);
    expect(skins.codex.down).toHaveLength(7);
    expect(skins.codex.down[0]).toHaveLength(32);
    // Opaque pixel of the solid fill (exact hex format is pngDecoder's business).
    expect(skins.codex.down[0][0][0]).toMatch(/^#[0-9A-F]{6}$/i);
    expect(skins.codex.right[6][31][15]).toBe(skins.codex.down[0][0][0]);
    expect(loadProviderSkins(path.join(root, 'missing'))).toEqual({});
  });

  it('external directories contribute skins (even without char_N.png) and win on merge', () => {
    png(path.join(root, 'assets', 'characters', 'agents', 'codex.png'), 112, 96, [0, 255, 0]);
    const external = loadExternalCharacterSprites(root);
    return external.then((ext) => {
      expect(ext?.characters).toEqual([]);
      const bundled = {
        characters: [],
        providerSkins: {
          codex: { down: [], up: [], right: [] },
          gemini: { down: [], up: [], right: [] },
        },
      };
      const merged = mergeCharacterSprites(bundled, ext!);
      // The external skin replaced the bundled (empty) one.
      expect(merged.providerSkins?.codex).toBe(ext!.providerSkins!.codex);
      expect(merged.providerSkins?.codex.down).toHaveLength(7);
      expect(Object.keys(merged.providerSkins ?? {}).sort()).toEqual(['codex', 'gemini']);
      expect(characterSpritesMessage(merged)).toMatchObject({
        type: 'characterSpritesLoaded',
        providerSkins: { codex: expect.any(Object) },
      });
      expect(characterSpritesMessage({ characters: [] })).toEqual({
        type: 'characterSpritesLoaded',
        characters: [],
      });
    });
  });
});
