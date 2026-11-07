/**
 * Which mascot Claude characters wear: the current skin (`claude`) or the
 * square classic one (`claude-classic`, sent by the server when its PNG exists).
 *
 * A tiny observable store read by the sprite resolver (every frame) and by
 * React (mug shots, the Settings row). Two sources feed it:
 *   - the normal-mode preference, persisted in localStorage (default 'new');
 *   - wallpaper mode's setting, which, when set, wins over the preference.
 *
 * DOM-free at the type level (storage is reached through globalThis) so the
 * Node-side test build can import it.
 */

import {
  CLAUDE_CLASSIC_SKIN_ID,
  CLAUDE_SKIN_STORAGE_KEY,
  DEFAULT_PROVIDER_ID,
} from './constants.js';

export type ClaudeSkinChoice = 'new' | 'classic';

/** 'new' / 'classic' (case-insensitive, trimmed); anything else is null. */
export function parseClaudeSkinChoice(value: unknown): ClaudeSkinChoice | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return v === 'new' || v === 'classic' ? v : null;
}

/**
 * The providerSkins key a character of `providerId` is drawn with: Claude
 * (or a missing id) wears `claude-classic` when that is the choice AND the
 * skin is loaded; everything else keeps its own id.
 */
export function resolveSkinId(
  providerId: string | undefined,
  choice: ClaudeSkinChoice,
  hasSkin: (id: string) => boolean,
): string {
  const id = providerId ?? DEFAULT_PROVIDER_ID;
  if (id === DEFAULT_PROVIDER_ID && choice === 'classic' && hasSkin(CLAUDE_CLASSIC_SKIN_ID)) {
    return CLAUDE_CLASSIC_SKIN_ID;
  }
  return id;
}

// ── Store ─────────────────────────────────────────────────────────────────────

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    // Accessing localStorage throws in some sandboxed / privacy contexts.
    return null;
  }
}

function loadPreference(): ClaudeSkinChoice {
  try {
    return parseClaudeSkinChoice(storage()?.getItem(CLAUDE_SKIN_STORAGE_KEY)) ?? 'new';
  } catch {
    return 'new';
  }
}

let preference: ClaudeSkinChoice | null = null; // lazily loaded
let override: ClaudeSkinChoice | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** The normal-mode preference (localStorage), ignoring any wallpaper override. */
export function getClaudeSkinPreference(): ClaudeSkinChoice {
  preference ??= loadPreference();
  return preference;
}

/** The choice in effect: the wallpaper override when set, else the preference. */
export function getClaudeSkin(): ClaudeSkinChoice {
  return override ?? getClaudeSkinPreference();
}

/** Set (and persist) the normal-mode preference. Storage errors are ignored. */
export function setClaudeSkinPreference(choice: ClaudeSkinChoice): void {
  const before = getClaudeSkin();
  preference = choice;
  try {
    storage()?.setItem(CLAUDE_SKIN_STORAGE_KEY, choice);
  } catch {
    /* quota / disabled storage: keep the in-memory choice */
  }
  if (getClaudeSkin() !== before) notify();
}

/** Wallpaper mode's choice; null hands control back to the preference. */
export function setClaudeSkinOverride(choice: ClaudeSkinChoice | null): void {
  const before = getClaudeSkin();
  override = choice;
  if (getClaudeSkin() !== before) notify();
}

export function subscribeClaudeSkin(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
