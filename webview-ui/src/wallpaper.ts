/**
 * Wallpaper mode: `?wallpaper=1` turns the page into an office-only view for a
 * live desktop wallpaper (e.g. a Wallpaper Engine web wallpaper loading the
 * standalone office URL in a fullscreen iframe). App renders only the canvas
 * and the character overlay, sounds are muted, pointer input is ignored, and
 * the camera fits the whole office into the viewport.
 *
 *   wallpaper=1        enable
 *   labels=0|1         hide / show name+activity labels (bubbles stay)
 *   chatter=0|1        hide / show the binary chatter bubbles
 *   zoom=N             force zoom N instead of fitting (0 = fit)
 *   bg=RRGGBB          background colour around the office (hex, no #)
 *   claudeSkin=classic Claude characters wear the classic mascot ('new' default)
 *   vignette=0|1       hide / show the vignette overlay
 *
 * These are only the initial values: wallpaperSettings.ts holds the live
 * settings, which Wallpaper Engine updates without a reload.
 *
 * The parsing and camera maths are pure (Node-tested); the only DOM access is
 * {@link wallpaperParams} reading `window.location.search` once.
 */

import { type ClaudeSkinChoice, parseClaudeSkinChoice } from './claudeSkin.js';
import {
  WALLPAPER_BG_PARAM,
  WALLPAPER_CHATTER_PARAM,
  WALLPAPER_CLAUDE_SKIN_PARAM,
  WALLPAPER_FIT_MARGIN_FRACTION,
  WALLPAPER_LABELS_PARAM,
  WALLPAPER_PARAM,
  WALLPAPER_TOP_OVERHANG_TILES,
  WALLPAPER_VIGNETTE_PARAM,
  WALLPAPER_ZOOM_MAX,
  WALLPAPER_ZOOM_PARAM,
  ZOOM_MIN,
} from './constants.js';
import { TILE_SIZE, TileType } from './office/types.js';

export interface WallpaperParams {
  enabled: boolean;
  /** Name/activity labels shown (always, since there is no hover). */
  labels: boolean;
  /** Binary chatter bubbles shown (roaming conversations run either way). */
  chatter: boolean;
  /** Forced zoom, or null to fit the office to the viewport. */
  zoom: number | null;
  /** Background colour as 6 lowercase hex digits (no #), or null for the theme's. */
  bg: string | null;
  /** Claude skin chosen by the wallpaper, or null to keep the saved preference. */
  claudeSkin: ClaudeSkinChoice | null;
  /** Vignette overlay shown. */
  vignette: boolean;
}

function isTruthy(value: string | null): boolean {
  return value === '1' || value === 'true';
}

function isFalsy(value: string | null): boolean {
  return value === '0' || value === 'false';
}

/**
 * A wallpaper zoom value: a whole number of device px per world px, 0 (or
 * less) meaning "fit". Returns null for fit, undefined for garbage (not a
 * number), and clamps the rest to [ZOOM_MIN, WALLPAPER_ZOOM_MAX].
 */
export function parseWallpaperZoom(raw: unknown): number | null | undefined {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
  else return undefined;
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded <= 0) return null;
  return Math.max(ZOOM_MIN, Math.min(WALLPAPER_ZOOM_MAX, rounded));
}

const HEX6 = /^#?([0-9a-f]{6})$/i;

/** "RRGGBB" (optionally with a leading #) → 6 lowercase hex digits; else null. */
export function normalizeHexColor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = HEX6.exec(raw.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Wallpaper Engine's colour property ("r g b", floats in 0..1) → 6 lowercase
 * hex digits. Components outside 0..1 are clamped; anything that is not
 * exactly three finite numbers is null.
 */
export function wallpaperEngineColorToHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.trim().split(/[\s,]+/);
  if (parts.length !== 3) return null;
  let hex = '';
  for (const part of parts) {
    if (part === '') return null;
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    const byte = Math.round(Math.max(0, Math.min(1, n)) * 255);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function parseWallpaperParams(search: string): WallpaperParams {
  const params = new URLSearchParams(search);
  const enabled = isTruthy(params.get(WALLPAPER_PARAM));
  const zoom = parseWallpaperZoom(params.get(WALLPAPER_ZOOM_PARAM)) ?? null;
  return {
    enabled,
    labels: !isFalsy(params.get(WALLPAPER_LABELS_PARAM)),
    chatter: !isFalsy(params.get(WALLPAPER_CHATTER_PARAM)),
    zoom: enabled ? zoom : null,
    bg: normalizeHexColor(params.get(WALLPAPER_BG_PARAM)),
    claudeSkin: parseClaudeSkinChoice(params.get(WALLPAPER_CLAUDE_SKIN_PARAM)),
    vignette: !isFalsy(params.get(WALLPAPER_VIGNETTE_PARAM)),
  };
}

let cached: WallpaperParams | null = null;

/** The page's wallpaper parameters, parsed from the URL once. */
export function wallpaperParams(): WallpaperParams {
  if (!cached) {
    // globalThis (not window) so the Node-side test build, which has no DOM
    // lib, still type-checks this module.
    const loc = (globalThis as { location?: { search?: string } }).location;
    cached = parseWallpaperParams(loc?.search ?? '');
  }
  return cached;
}

export function isWallpaperMode(): boolean {
  return wallpaperParams().enabled;
}

/** World-pixel box the fit has to show. */
export interface WorldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The drawn part of the layout in world pixels: the bounding box of every
 * non-VOID tile, plus headroom above the top row for wall faces and tall
 * furniture. Layouts commonly pad the grid with VOID rows, which the fit
 * should not spend screen space on. An all-VOID (or tile-less) layout falls
 * back to the whole grid.
 */
export function layoutContentBounds(layout: {
  cols: number;
  rows: number;
  tiles: readonly number[];
}): WorldBounds {
  const { cols, rows, tiles } = layout;
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const t = tiles[r * cols + c];
      if (t === undefined || t === TileType.VOID) continue;
      if (c < minCol) minCol = c;
      if (c > maxCol) maxCol = c;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
    }
  }
  if (minCol === Infinity) {
    return { x: 0, y: 0, width: cols * TILE_SIZE, height: rows * TILE_SIZE };
  }
  const top = minRow - WALLPAPER_TOP_OVERHANG_TILES;
  return {
    x: minCol * TILE_SIZE,
    y: top * TILE_SIZE,
    width: (maxCol - minCol + 1) * TILE_SIZE,
    height: (maxRow - top + 1) * TILE_SIZE,
  };
}

/**
 * Largest integer zoom (device px per world px) at which a `contentW` ×
 * `contentH` world box fits a `viewW` × `viewH` device-pixel viewport with
 * `marginFraction` of each dimension left empty on both sides. Never below
 * ZOOM_MIN: an office too big even at 1 is shown at 1 (centred, cropped).
 */
export function computeFitZoom(
  viewW: number,
  viewH: number,
  contentW: number,
  contentH: number,
  marginFraction: number = WALLPAPER_FIT_MARGIN_FRACTION,
): number {
  if (contentW <= 0 || contentH <= 0 || viewW <= 0 || viewH <= 0) return ZOOM_MIN;
  const availW = viewW * (1 - 2 * marginFraction);
  const availH = viewH * (1 - 2 * marginFraction);
  const fit = Math.floor(Math.min(availW / contentW, availH / contentH));
  return Math.max(ZOOM_MIN, Math.min(WALLPAPER_ZOOM_MAX, fit));
}

export interface WallpaperCamera {
  zoom: number;
  /** Device-pixel pan in the renderer's convention (0 = grid centred). */
  pan: { x: number; y: number };
}

/**
 * Zoom + pan that show the layout's content centred in a `viewW` × `viewH`
 * device-pixel canvas. The renderer centres the whole grid and then adds the
 * pan, so the pan is the offset from the grid's centre to the content's.
 */
export function computeWallpaperCamera(
  layout: { cols: number; rows: number; tiles: readonly number[] },
  viewW: number,
  viewH: number,
  forcedZoom: number | null = null,
): WallpaperCamera {
  const bounds = layoutContentBounds(layout);
  const zoom = forcedZoom ?? computeFitZoom(viewW, viewH, bounds.width, bounds.height);
  const gridCenterX = (layout.cols * TILE_SIZE) / 2;
  const gridCenterY = (layout.rows * TILE_SIZE) / 2;
  const contentCenterX = bounds.x + bounds.width / 2;
  const contentCenterY = bounds.y + bounds.height / 2;
  return {
    zoom,
    pan: {
      x: Math.round((gridCenterX - contentCenterX) * zoom),
      y: Math.round((gridCenterY - contentCenterY) * zoom),
    },
  };
}
