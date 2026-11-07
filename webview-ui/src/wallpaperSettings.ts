/**
 * Wallpaper mode's live settings: initialised from the URL (wallpaper.ts) and
 * then updated without a reload by Wallpaper Engine, which calls
 * `window.wallpaperPropertyListener.applyUserProperties(props)` on the page
 * with only the changed user properties:
 *
 *   showlabels       { value: boolean }        → labels
 *   chatter          { value: boolean }        → chatter
 *   zoom             { value: number }         → zoom (0 = fit)
 *   backgroundcolor  { value: "r g b" }        → bg (floats 0..1)
 *   claudeskin       { value: "new"|"classic" }→ claudeSkin
 *   vignette         { value: boolean }        → vignette
 *
 * Unknown keys and invalid values are ignored. A tiny observable store
 * (subscribe / notify, immutable snapshots) so React (useSyncExternalStore)
 * and imperative code read the same current values.
 *
 * The mapping is pure and DOM-free (Node-tested); the listener is installed
 * on globalThis, only in wallpaper mode.
 */

import {
  type ClaudeSkinChoice,
  parseClaudeSkinChoice,
  setClaudeSkinOverride,
} from './claudeSkin.js';
import {
  WE_PROP_BACKGROUND_COLOR,
  WE_PROP_CHATTER,
  WE_PROP_CLAUDE_SKIN,
  WE_PROP_SHOW_LABELS,
  WE_PROP_VIGNETTE,
  WE_PROP_ZOOM,
} from './constants.js';
import {
  normalizeHexColor,
  parseWallpaperZoom,
  wallpaperEngineColorToHex,
  type WallpaperParams,
} from './wallpaper.js';

export interface WallpaperSettings {
  labels: boolean;
  chatter: boolean;
  /** Forced zoom, or null to fit. */
  zoom: number | null;
  /** 6 lowercase hex digits (no #), or null for the theme background. */
  bg: string | null;
  /** null = keep the saved normal-mode preference. */
  claudeSkin: ClaudeSkinChoice | null;
  vignette: boolean;
}

export const DEFAULT_WALLPAPER_SETTINGS: WallpaperSettings = {
  labels: true,
  chatter: true,
  zoom: null,
  bg: null,
  claudeSkin: null,
  vignette: true,
};

export function settingsFromParams(params: WallpaperParams): WallpaperSettings {
  return {
    labels: params.labels,
    chatter: params.chatter,
    zoom: params.zoom,
    bg: params.bg,
    claudeSkin: params.claudeSkin,
    vignette: params.vignette,
  };
}

/** A WE boolean: real booleans, plus the 1/0 and "true"/"false" spellings. */
function weBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

/** `props[key].value`, or undefined when the key is absent or malformed. */
function propValue(props: Record<string, unknown>, key: string): unknown {
  const entry = props[key];
  if (!entry || typeof entry !== 'object' || !('value' in entry)) return undefined;
  return (entry as { value: unknown }).value;
}

/**
 * Translate a Wallpaper Engine `applyUserProperties` payload into a settings
 * patch. Only keys present AND valid appear in the patch.
 */
export function mapWallpaperEngineProps(props: unknown): Partial<WallpaperSettings> {
  const patch: Partial<WallpaperSettings> = {};
  if (!props || typeof props !== 'object') return patch;
  const p = props as Record<string, unknown>;

  const labels = weBool(propValue(p, WE_PROP_SHOW_LABELS));
  if (labels !== undefined) patch.labels = labels;

  const chatter = weBool(propValue(p, WE_PROP_CHATTER));
  if (chatter !== undefined) patch.chatter = chatter;

  const vignette = weBool(propValue(p, WE_PROP_VIGNETTE));
  if (vignette !== undefined) patch.vignette = vignette;

  const zoom = parseWallpaperZoom(propValue(p, WE_PROP_ZOOM));
  if (zoom !== undefined) patch.zoom = zoom;

  const rawBg = propValue(p, WE_PROP_BACKGROUND_COLOR);
  const bg = wallpaperEngineColorToHex(rawBg) ?? normalizeHexColor(rawBg);
  if (bg !== null) patch.bg = bg;

  const skin = parseClaudeSkinChoice(propValue(p, WE_PROP_CLAUDE_SKIN));
  if (skin !== null) patch.claudeSkin = skin;

  return patch;
}

/** Apply a patch; returns `current` itself when nothing changes. */
export function applySettingsPatch(
  current: WallpaperSettings,
  patch: Partial<WallpaperSettings>,
): WallpaperSettings {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof WallpaperSettings)[]) {
    if (patch[key] !== undefined && patch[key] !== current[key]) changed = true;
  }
  if (!changed) return current;
  const next = { ...current };
  for (const key of Object.keys(patch) as (keyof WallpaperSettings)[]) {
    const v = patch[key];
    if (v !== undefined) (next as Record<string, unknown>)[key] = v;
  }
  return next;
}

// ── Store ─────────────────────────────────────────────────────────────────────

let settings: WallpaperSettings = DEFAULT_WALLPAPER_SETTINGS;
const listeners = new Set<() => void>();

export function getWallpaperSettings(): WallpaperSettings {
  return settings;
}

export function subscribeWallpaperSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setSettings(next: WallpaperSettings): void {
  if (next === settings) return;
  settings = next;
  // The wallpaper's Claude skin wins over the saved preference while set.
  setClaudeSkinOverride(settings.claudeSkin);
  for (const l of listeners) l();
}

export function updateWallpaperSettings(patch: Partial<WallpaperSettings>): void {
  setSettings(applySettingsPatch(settings, patch));
}

interface WallpaperPropertyListener {
  applyUserProperties?: (props: unknown) => void;
  applyGeneralProperties?: (props: unknown) => void;
  [key: string]: unknown;
}

let installed = false;

/**
 * Wallpaper mode bootstrap: seed the store from the URL, hand the wallpaper's
 * Claude skin to the skin store, and register `wallpaperPropertyListener` so
 * Wallpaper Engine can push changes live. Idempotent. Fields of an existing
 * listener object other than applyUserProperties are kept.
 */
export function initWallpaperSettings(params: WallpaperParams): void {
  if (installed) return;
  installed = true;
  settings = settingsFromParams(params);
  setClaudeSkinOverride(settings.claudeSkin);
  const g = globalThis as { wallpaperPropertyListener?: WallpaperPropertyListener };
  const existing = g.wallpaperPropertyListener;
  g.wallpaperPropertyListener = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    applyUserProperties(props: unknown) {
      try {
        updateWallpaperSettings(mapWallpaperEngineProps(props));
      } catch (err) {
        console.warn('[Wallpaper] Ignoring user properties:', err);
      }
    },
  };
}
