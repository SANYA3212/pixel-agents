/**
 * Provider session watchers: show non-Claude coding agents (Codex, OpenCode,
 * Gemini CLI, Qwen Code, Kimi, Copilot CLI, Cursor agent) as office agents by
 * reading their own session stores, read-only. Every watcher silently no-ops
 * while its data directory is missing and starts working once it appears.
 */

import * as os from 'os';

import { createCodexWatcher } from './codex.js';
import { createCopilotWatcher } from './copilot.js';
import { createCursorWatcher } from './cursor.js';
import { createGeminiWatchers } from './gemini.js';
import { createKimiWatcher } from './kimi.js';
import { createOpenCodeWatcher } from './opencode.js';
import { createQwenWatchers } from './qwen.js';
import type { ProviderWatcher, WatchedProviderId } from './types.js';

export { ProviderWatcherManager } from './providerWatcherManager.js';

/**
 * Build the watchers for every enabled provider (all by default).
 * `PIXEL_AGENTS_WATCH_PROVIDERS=codex,opencode` restricts the set;
 * `PIXEL_AGENTS_WATCH_PROVIDERS=none` disables them all.
 */
export function createDefaultProviderWatchers(
  home = os.homedir(),
  enabled: readonly string[] | undefined = parseEnabledEnv(),
): ProviderWatcher[] {
  const on = (id: WatchedProviderId) => !enabled || enabled.includes(id);
  const watchers: ProviderWatcher[] = [];
  if (on('codex')) watchers.push(createCodexWatcher(home));
  if (on('opencode')) watchers.push(createOpenCodeWatcher(home));
  if (on('kimi')) watchers.push(createKimiWatcher(home));
  if (on('gemini')) watchers.push(...createGeminiWatchers(home));
  if (on('qwen')) watchers.push(...createQwenWatchers(home));
  if (on('copilot')) watchers.push(createCopilotWatcher(home));
  if (on('cursor')) watchers.push(createCursorWatcher(home));
  return watchers;
}

function parseEnabledEnv(): string[] | undefined {
  const raw = process.env.PIXEL_AGENTS_WATCH_PROVIDERS;
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
