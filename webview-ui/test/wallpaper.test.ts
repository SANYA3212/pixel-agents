import { describe, expect, it } from 'vitest';

import { WALLPAPER_ZOOM_MAX } from '../src/constants.js';
import { TILE_SIZE, TileType } from '../src/office/types.js';
import {
  computeFitZoom,
  computeWallpaperCamera,
  layoutContentBounds,
  parseWallpaperParams,
} from '../src/wallpaper.js';

const V = TileType.VOID;
const F = TileType.FLOOR_1;
const W = TileType.WALL;

describe('parseWallpaperParams', () => {
  const DEFAULTS = {
    labels: true,
    chatter: true,
    zoom: null,
    bg: null,
    claudeSkin: null,
    vignette: true,
  };

  it('is off without wallpaper=1', () => {
    expect(parseWallpaperParams('')).toEqual({ enabled: false, ...DEFAULTS });
    expect(parseWallpaperParams('?token=abc&wallpaper=0')).toMatchObject({ enabled: false });
    // zoom only means something in wallpaper mode
    expect(parseWallpaperParams('?zoom=4').zoom).toBeNull();
  });

  it('reads wallpaper, labels and zoom alongside other params', () => {
    expect(parseWallpaperParams('?token=abc&wallpaper=1')).toEqual({
      enabled: true,
      ...DEFAULTS,
    });
    expect(parseWallpaperParams('?wallpaper=true&labels=0&zoom=5')).toEqual({
      enabled: true,
      ...DEFAULTS,
      labels: false,
      zoom: 5,
    });
    expect(parseWallpaperParams('?wallpaper=1&labels=false').labels).toBe(false);
  });

  it('reads chatter, bg, claudeSkin and vignette', () => {
    expect(
      parseWallpaperParams('?wallpaper=1&bg=102030&chatter=0&claudeSkin=classic&vignette=0'),
    ).toEqual({
      enabled: true,
      ...DEFAULTS,
      chatter: false,
      bg: '102030',
      claudeSkin: 'classic',
      vignette: false,
    });
    expect(parseWallpaperParams('?wallpaper=1&chatter=1&vignette=true&claudeSkin=NEW')).toEqual({
      enabled: true,
      ...DEFAULTS,
      claudeSkin: 'new',
    });
    // a leading # (URL-encoded) is accepted, case is normalized
    expect(parseWallpaperParams('?wallpaper=1&bg=%23A0B0C0').bg).toBe('a0b0c0');
  });

  it('ignores garbage bg / claudeSkin values', () => {
    for (const bg of ['12345', '1234567', 'zzzzzz', 'red', '', '%20']) {
      expect(parseWallpaperParams(`?wallpaper=1&bg=${bg}`).bg).toBeNull();
    }
    expect(parseWallpaperParams('?wallpaper=1&claudeSkin=old').claudeSkin).toBeNull();
    expect(parseWallpaperParams('?wallpaper=1&chatter=maybe').chatter).toBe(true);
  });

  it('clamps and rounds a forced zoom, ignores garbage; 0 means fit', () => {
    expect(parseWallpaperParams('?wallpaper=1&zoom=0').zoom).toBeNull();
    expect(parseWallpaperParams('?wallpaper=1&zoom=-2').zoom).toBeNull();
    expect(parseWallpaperParams('?wallpaper=1&zoom=1').zoom).toBe(1);
    expect(parseWallpaperParams('?wallpaper=1&zoom=3.6').zoom).toBe(4);
    expect(parseWallpaperParams('?wallpaper=1&zoom=999').zoom).toBe(WALLPAPER_ZOOM_MAX);
    expect(parseWallpaperParams('?wallpaper=1&zoom=abc').zoom).toBeNull();
    expect(parseWallpaperParams('?wallpaper=1&zoom=').zoom).toBeNull();
  });
});

describe('computeFitZoom', () => {
  it('picks the largest integer zoom that fits inside the margin', () => {
    // 320x192 world px into 1920x1080 at 3% margin: min(5.64, 5.28) -> 5
    expect(computeFitZoom(1920, 1080, 320, 192, 0.03)).toBe(5);
    // 2560x1440: min(7.52, 7.05) -> 7
    expect(computeFitZoom(2560, 1440, 320, 192, 0.03)).toBe(7);
    // exact fit with no margin
    expect(computeFitZoom(640, 384, 320, 192, 0)).toBe(2);
  });

  it('is limited by the tighter axis (portrait)', () => {
    expect(computeFitZoom(1080, 1920, 320, 192, 0.03)).toBe(3);
  });

  it('never goes below 1 or above the wallpaper max', () => {
    expect(computeFitZoom(200, 100, 320, 192, 0.03)).toBe(1);
    expect(computeFitZoom(100000, 100000, 16, 16, 0)).toBe(WALLPAPER_ZOOM_MAX);
    expect(computeFitZoom(0, 0, 320, 192)).toBe(1);
  });
});

describe('layoutContentBounds', () => {
  it('skips VOID padding and adds a tile of headroom above the top row', () => {
    // 4x4 grid, content in cols 1..2, rows 2..3
    const tiles = [V, V, V, V, V, V, V, V, V, W, W, V, V, F, F, V];
    expect(layoutContentBounds({ cols: 4, rows: 4, tiles })).toEqual({
      x: 1 * TILE_SIZE,
      y: 1 * TILE_SIZE,
      width: 2 * TILE_SIZE,
      height: 3 * TILE_SIZE,
    });
  });

  it('falls back to the whole grid when everything is VOID', () => {
    expect(layoutContentBounds({ cols: 2, rows: 3, tiles: [V, V, V, V, V, V] })).toEqual({
      x: 0,
      y: 0,
      width: 2 * TILE_SIZE,
      height: 3 * TILE_SIZE,
    });
  });
});

describe('computeWallpaperCamera', () => {
  it('a full grid is centred with no pan', () => {
    const tiles = new Array(20 * 11).fill(F);
    tiles.fill(W, 0, 20);
    const cam = computeWallpaperCamera({ cols: 20, rows: 11, tiles }, 1920, 1080);
    // content 320 x 192 (11 rows + 1 headroom): zoom 5; headroom shifts the
    // content centre half a tile up, so the pan pushes the grid half a tile down
    expect(cam.zoom).toBe(5);
    expect(cam.pan).toEqual({ x: 0, y: (TILE_SIZE / 2) * 5 });
  });

  it('pans VOID-padded content to the centre and honours a forced zoom', () => {
    // 4x4 grid with content only in the bottom-right 2x2
    const tiles = [V, V, V, V, V, V, V, V, V, V, F, F, V, V, F, F];
    const cam = computeWallpaperCamera({ cols: 4, rows: 4, tiles }, 1000, 1000, 3);
    expect(cam.zoom).toBe(3);
    // grid centre (32,32); content box x 32..64, y 16..64 -> centre (48,40)
    expect(cam.pan).toEqual({ x: (32 - 48) * 3, y: (32 - 40) * 3 });
  });
});
