/**
 * ProviderWatcherManager: turns provider watcher snapshots into agents.
 *
 * Every poll it diffs each session snapshot against the AgentStateStore and
 * emits exactly the broadcasts the Claude path emits, so the office animates
 * watched agents with no provider-specific UI code:
 *   new session        -> store.set (agentCreated) [+ agentToolStart/agentStatus]
 *   tool appeared      -> agentToolStart          (hookEventHandler PreToolUse shape)
 *   tool finished      -> agentToolDone           (PostToolUse shape)
 *   turn started       -> agentStatus 'active'
 *   turn finished      -> agentToolsClear + agentStatus 'waiting'   (Stop shape)
 *   quiet / ended      -> removeAgent (agentClosed)
 *
 * Watched agents are headless (no terminal): focusing them is a client-side
 * no-op, and closing one (closeAgent -> AgentRuntime.closeAgent) only hides it
 * until the session shows NEW activity. They are never persisted.
 */

import { createAgentState } from '../agentState.js';
import type { AgentStateStore } from '../agentStateStore.js';
import {
  PROVIDER_WATCH_ACTIVE_STALE_MS,
  PROVIDER_WATCH_ACTIVE_WINDOW_MS,
  PROVIDER_WATCH_AGENT_ID_BASE,
  PROVIDER_WATCH_POLL_INTERVAL_MS,
  PROVIDER_WATCH_REMOVE_AFTER_MS,
} from '../constants.js';
import { assignPaletteIfNeeded } from '../paletteAssigner.js';
import { toPathKey } from '../pathKey.js';
import type { AgentState } from '../types.js';
import { baseName } from './toolLabels.js';
import type {
  ProviderWatcher,
  WatchedSessionSnapshot,
  WatchedSessionState,
  WatchedTool,
} from './types.js';
import { PROVIDER_DISPLAY_NAMES } from './types.js';

export interface ProviderWatcherManagerOptions {
  store: AgentStateStore;
  watchers: ProviderWatcher[];
  /** The runtime's Watch All Sessions ref. Off: only sessions whose cwd lies
   *  inside one of `scopeDirs()` are shown (same rule as Claude adoption). */
  watchAllSessions: { current: boolean };
  scopeDirs?: () => string[];
  /** Full-cleanup removal (AgentRuntime.removeAgent). Defaults to store.delete. */
  removeAgent?: (id: number) => void;
  now?: () => number;
}

interface Entry {
  agentId: number;
  lastActivity: number;
  state: WatchedSessionState;
}

/** Label shown on the character: "Codex · my-repo", "Codex Desktop · Kuhn". */
export function agentLabelFor(s: WatchedSessionSnapshot): string {
  const name = s.variant ?? PROVIDER_DISPLAY_NAMES[s.providerId] ?? s.providerId;
  const dir = s.cwd ? baseName(s.cwd) : undefined;
  let detail: string;
  if (s.labelDetail === 'subagent') {
    detail = dir ? `${dir} (subagent)` : 'subagent';
  } else {
    detail = s.labelDetail ?? dir ?? s.title ?? s.sessionId.slice(0, 8);
  }
  return detail ? `${name} · ${detail}` : name;
}

function isInside(child: string, parent: string): boolean {
  const c = toPathKey(child);
  const p = toPathKey(parent);
  if (c === p) return true;
  const sep = p.endsWith('/') || p.endsWith('\\') ? '' : process.platform === 'win32' ? '\\' : '/';
  return c.startsWith(p + sep);
}

export class ProviderWatcherManager {
  private readonly bySession = new Map<string, Entry>();
  private readonly byAgent = new Map<number, string>();
  /** Sessions the user closed: key -> lastActivity at that moment. Re-shown
   *  only once the session's activity moves past it. */
  private readonly dismissed = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private selfRemoving = false;
  private nextId = PROVIDER_WATCH_AGENT_ID_BASE;
  private readonly onAgentRemoved = (id: number) => this.handleAgentRemoved(id);

  constructor(private readonly opts: ProviderWatcherManagerOptions) {
    opts.store.on('agentRemoved', this.onAgentRemoved);
  }

  start(intervalMs = PROVIDER_WATCH_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Never keep the process alive just for polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.store.off('agentRemoved', this.onAgentRemoved);
    for (const w of this.opts.watchers) {
      try {
        w.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  /** Agent id of a tracked session (tests, diagnostics). */
  agentIdFor(providerId: string, sessionId: string): number | undefined {
    return this.bySession.get(`${providerId}:${sessionId}`)?.agentId;
  }

  tick(now = this.opts.now?.() ?? Date.now()): void {
    // Newest snapshot per session (a session may be visible through two files).
    const latest = new Map<string, WatchedSessionSnapshot>();
    for (const w of this.opts.watchers) {
      let snaps: WatchedSessionSnapshot[];
      try {
        snaps = w.poll(now);
      } catch (err) {
        console.warn(
          `[Pixel Agents] Provider watcher ${w.providerId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      for (const s of snaps) {
        const key = `${s.providerId}:${s.sessionId}`;
        const prev = latest.get(key);
        if (!prev || s.lastActivity >= prev.lastActivity) latest.set(key, s);
      }
    }

    for (const [key, s] of latest) {
      const state = this.effectiveState(s, now);
      const gone =
        state === 'ended' ||
        now - s.lastActivity > PROVIDER_WATCH_REMOVE_AFTER_MS ||
        !this.inScope(s.cwd);
      const entry = this.bySession.get(key);
      if (!entry) {
        if (gone || now - s.lastActivity > PROVIDER_WATCH_ACTIVE_WINDOW_MS) continue;
        const dismissedAt = this.dismissed.get(key);
        if (dismissedAt !== undefined) {
          if (s.lastActivity <= dismissedAt) continue;
          this.dismissed.delete(key);
        }
        this.create(key, s, state);
      } else if (gone) {
        this.remove(entry.agentId);
      } else {
        this.apply(entry, s, state);
      }
    }

    for (const [key, entry] of [...this.bySession]) {
      if (!latest.has(key)) this.remove(entry.agentId);
    }
    for (const [key, at] of this.dismissed) {
      if (now - at > PROVIDER_WATCH_REMOVE_AFTER_MS) this.dismissed.delete(key);
    }
  }

  // ── internals ──

  private effectiveState(s: WatchedSessionSnapshot, now: number): WatchedSessionState {
    // An "active" turn with no running tool that went silent long ago most
    // likely died with its process: show it as waiting rather than typing forever.
    if (
      s.state === 'active' &&
      s.tools.length === 0 &&
      now - s.lastActivity > PROVIDER_WATCH_ACTIVE_STALE_MS
    ) {
      return 'waiting';
    }
    return s.state;
  }

  private inScope(cwd: string | undefined): boolean {
    if (this.opts.watchAllSessions.current) return true;
    if (!cwd) return false;
    return (this.opts.scopeDirs?.() ?? []).some((d) => d && isInside(cwd, d));
  }

  private allocateId(): number {
    while (this.opts.store.has(this.nextId)) this.nextId++;
    return this.nextId++;
  }

  private create(key: string, s: WatchedSessionSnapshot, state: WatchedSessionState): void {
    const { store } = this.opts;
    const id = this.allocateId();
    const label = agentLabelFor(s);
    const agent = createAgentState({
      id,
      sessionId: s.sessionId,
      isExternal: true,
      projectDir: s.cwd ?? '',
      jsonlFile: s.sourcePath,
      providerId: s.providerId,
      agentLabel: label,
      providerWatched: true,
      // No heuristic (Claude transcript) timers ever apply to these agents.
      hookDelivered: true,
      lastDataAt: s.lastActivity,
      directoryName: s.cwd ? baseName(s.cwd) : undefined,
      // A session first seen between turns appears quietly (no chime).
      isWaiting: state !== 'active',
    });
    assignPaletteIfNeeded(agent, store);
    this.bySession.set(key, { agentId: id, lastActivity: s.lastActivity, state });
    this.byAgent.set(id, key);
    store.set(id, agent);
    console.log(`[Pixel Agents] Watcher: Agent ${id} - adopted ${label} (${state})`);
    if (state === 'active') {
      for (const t of s.tools) this.startTool(agent, t);
      store.broadcast({ type: 'agentStatus', id, status: 'active' });
    }
  }

  private apply(entry: Entry, s: WatchedSessionSnapshot, state: WatchedSessionState): void {
    const { store } = this.opts;
    const agent = store.get(entry.agentId);
    if (!agent) return;
    agent.lastDataAt = s.lastActivity;
    entry.lastActivity = s.lastActivity;
    if (state === 'active') {
      const want = new Set(s.tools.map((t) => t.id));
      for (const toolId of [...agent.activeToolIds]) {
        if (want.has(toolId)) continue;
        this.forgetTool(agent, toolId);
        store.broadcast({ type: 'agentToolDone', id: agent.id, toolId });
      }
      for (const t of s.tools) {
        if (!agent.activeToolIds.has(t.id)) this.startTool(agent, t);
      }
      if (entry.state !== 'active' || agent.isWaiting) {
        agent.isWaiting = false;
        store.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
      }
    } else if (entry.state === 'active' || !agent.isWaiting) {
      if (agent.activeToolIds.size > 0) {
        for (const toolId of [...agent.activeToolIds]) this.forgetTool(agent, toolId);
        store.broadcast({ type: 'agentToolsClear', id: agent.id });
      }
      agent.isWaiting = true;
      store.broadcast({ type: 'agentStatus', id: agent.id, status: 'waiting' });
    }
    entry.state = state;
  }

  private startTool(agent: AgentState, t: WatchedTool): void {
    agent.activeToolIds.add(t.id);
    agent.activeToolStatuses.set(t.id, t.status);
    agent.activeToolNames.set(t.id, t.name);
    agent.hadToolsInTurn = true;
    this.opts.store.broadcast({
      type: 'agentToolStart',
      id: agent.id,
      toolId: t.id,
      status: t.status,
      toolName: t.name,
    });
  }

  private forgetTool(agent: AgentState, toolId: string): void {
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
  }

  private remove(agentId: number): void {
    this.selfRemoving = true;
    try {
      if (this.opts.removeAgent) this.opts.removeAgent(agentId);
      else this.opts.store.delete(agentId);
    } finally {
      this.selfRemoving = false;
    }
    // removeAgent fires agentRemoved -> handleAgentRemoved drops the maps; if the
    // agent was already gone, drop them here.
    const key = this.byAgent.get(agentId);
    if (key !== undefined) {
      this.byAgent.delete(agentId);
      this.bySession.delete(key);
    }
  }

  private handleAgentRemoved(id: number): void {
    const key = this.byAgent.get(id);
    if (key === undefined) return;
    const entry = this.bySession.get(key);
    this.byAgent.delete(id);
    this.bySession.delete(key);
    // Removed by someone else (the user closed it): hide until new activity.
    if (!this.selfRemoving && entry) this.dismissed.set(key, entry.lastActivity);
  }
}
