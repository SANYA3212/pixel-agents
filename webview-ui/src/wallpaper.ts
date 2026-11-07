/**
 * Wallpaper mode: `?wallpaper=1` turns the page into an office-only view for a
 * live desktop wallpaper (e.g. a Wallpaper Engine web wallpaper loading the
 * standalone office URL in a fullscreen iframe). App renders only the canvas
 * and the character overlay, sounds are muted, pointer input is ignored, and
 * the camera fits the whole office into the viewport.
 *
 *   wallpaper=1   enable
 *   labels=0      hide name/activity labels (bubbles stay)
 *   zoom=N        force zoom N instead of fitting
 *
 * The parsing and camera maths are pure (Node-tested); the only DOM access is
 * {@link wallpaperParams} reading `window.location.search` once.
 */

import {
  WALLPAPER_FIT_MARGIN_FRACTION,
  WALLPAPER_LABELS_PARAM,
  WALLPAPER_PARAM,
  WALLPAPER_TOP_OVERHANG_TILES,
  WALLPAPER_ZOOM_MAX,
  WALLPAPER_ZOOM_PARAM,
  ZOOM_MIN,
} from './constants.js';
import { TILE_SIZE, TileType } from './office/types.js';

export interface WallpaperParams {
  enabled: boolean;
  /** Name/activity labels shown (always, since there is no hover). */
  labels: boolean;
  /** Forced zoom, or null to fit the office to the viewport. */
  zoom: number | null;
}

function isTruthy(value: string | null): boolean {
  return value === '1' || value === 'true';
}

function isFalsy(value: string | null): boolean {
  return value === '0' || value === 'false';
}

export function parseWallpaperParams(search: string): WallpaperParams {
  const params = new URLSearchParams(search);
  const enabled = isTruthy(params.get(WALLPAPER_PARAM));
  const rawZoom = params.get(WALLPAPER_ZOOM_PARAM);
  const zoomNum = rawZoom === null || rawZoom.trim() === '' ? NaN : Number(rawZoom);
  const zoom = Number.isFinite(zoomNum)
    ? Math.max(ZOOM_MIN, Math.min(WALLPAPER_ZOOM_MAX, Math.round(zoomNum)))
    : null;
  return {
    enabled,
    labels: !isFalsy(params.get(WALLPAPER_LABELS_PARAM)),
    zoom: enabled ? zoom : null,
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
