/**
 * Provider session watchers: the common shape every non-Claude watcher reports.
 *
 * A watcher reads one coding agent's OWN session store (Codex rollout JSONL,
 * OpenCode's SQLite database, Gemini chat files, ...) read-only, and turns it
 * into normalized session snapshots. The ProviderWatcherManager diffs those
 * snapshots against the AgentStateStore and emits the same broadcasts the
 * Claude path emits (agentToolStart / agentToolDone / agentToolsClear /
 * agentStatus), so the office needs no provider-specific code.
 */

/** Provider ids of the watched (non-Claude) agents. Claude is 'claude'. */
export type WatchedProviderId =
  'codex' | 'opencode' | 'kimi' | 'gemini' | 'qwen' | 'copilot' | 'cursor';

/** Display names, used in the agent label ("Codex · my-repo"). */
export const PROVIDER_DISPLAY_NAMES: Record<WatchedProviderId, string> = {
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  gemini: 'Gemini',
  qwen: 'Qwen',
  copilot: 'Copilot',
  cursor: 'Cursor',
};

/**
 * Session state as the office understands it:
 *  - active: executing a turn
 *  - waiting: the turn finished (or was aborted); the agent waits for the user
 *  - ended: the session is closed/archived; its character should go
 */
export type WatchedSessionState = 'active' | 'waiting' | 'ended';

/** One running tool call. `name` is a CANONICAL (Claude-vocabulary) tool name
 *  when one fits (Bash, Read, Edit, Write, Grep, Glob, WebFetch, WebSearch), so
 *  the office picks the right animation (typing vs reading); `status` is the
 *  activity label shown above the character ("Running: npm test"). */
export interface WatchedTool {
  id: string;
  name: string;
  status: string;
}

/** What a provider parser knows about one session at a point in time. */
export interface ParsedSessionState {
  /** Provider's own session id (falls back to the source path). */
  sessionId?: string;
  /** Working directory of the session. */
  cwd?: string;
  /** Session title, when the provider stores one. */
  title?: string;
  /** Overrides the provider display name in the label (e.g. "Codex Desktop"). */
  variant?: string;
  /** Overrides the label detail (default: cwd basename), e.g. a sub-agent nickname. */
  labelDetail?: string;
  state: WatchedSessionState;
  /** Running tools, in start order. */
  tools: WatchedTool[];
  /** Newest record timestamp seen (ms since epoch), if the format has them. */
  lastEventAt?: number;
}

/** A normalized session snapshot reported by a watcher on each poll. */
export interface WatchedSessionSnapshot extends ParsedSessionState {
  providerId: WatchedProviderId;
  sessionId: string;
  /** File (or database) the session was read from — for diagnostics. */
  sourcePath: string;
  /** Last activity (ms since epoch): newest of file mtime and record timestamps. */
  lastActivity: number;
}

/** One provider's watcher. `poll` is synchronous and cheap when nothing changed. */
export interface ProviderWatcher {
  readonly providerId: WatchedProviderId;
  /** Return the snapshots of every session the watcher currently tracks
   *  (sessions with activity inside the adoption window, plus already-tracked
   *  ones until they go quiet for the removal window). */
  poll(now: number): WatchedSessionSnapshot[];
  /** Release handles (database connections). */
  dispose(): void;
}
