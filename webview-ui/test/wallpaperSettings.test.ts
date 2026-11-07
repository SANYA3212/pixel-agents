/**
 * Wallpaper mode's live settings and the Claude skin choice.
 *
 * Covers the pure parts — Wallpaper Engine property mapping, "r g b" → hex,
 * hex validation, zoom parsing, patch application, skin-id resolution — and
 * the two tiny stores: the wallpaper settings store fed by
 * window.wallpaperPropertyListener, and the Claude skin store (localStorage
 * preference + wallpaper override) that getSpritesForLook reads every frame.
 *
 * Run with: npm test
 */

import { describe, expect, it } from 'vitest';

// A fake localStorage installed BEFORE anything reads the skin preference (it
// is loaded lazily, once).
const store = new Map<string, string>([['pixelAgents.claudeSkin', 'classic']]);
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
};
(globalThis as { localStorage?: unknown }).localStorage = fakeStorage;

import {
  getClaudeSkin,
  getClaudeSkinPreference,
  parseClaudeSkinChoice,
  resolveSkinId,
  setClaudeSkinOverride,
  setClaudeSkinPreference,
  subscribeClaudeSkin,
} from '../src/claudeSkin.js';
import {
  CLAUDE_CLASSIC_SKIN_ID,
  CLAUDE_SKIN_STORAGE_KEY,
  WALLPAPER_ZOOM_MAX,
} from '../src/constants.js';
import { getSpritesForLook, setProviderSkins } from '../src/office/sprites/spriteData.js';
import { Direction } from '../src/office/types.js';
import {
  normalizeHexColor,
  parseWallpaperParams,
  parseWallpaperZoom,
  wallpaperEngineColorToHex,
} from '../src/wallpaper.js';
import {
  applySettingsPatch,
  DEFAULT_WALLPAPER_SETTINGS,
  getWallpaperSettings,
  initWallpaperSettings,
  mapWallpaperEngineProps,
  subscribeWallpaperSettings,
} from '../src/wallpaperSettings.js';

describe('colour helpers', () => {
  it('normalizes 6-digit hex with or without a leading #', () => {
    expect(normalizeHexColor('102030')).toBe('102030');
    expect(normalizeHexColor('  AbCdEf ')).toBe('abcdef');
    expect(normalizeHexColor('#' + '0a0B0c')).toBe('0a0b0c');
  });

  it('rejects anything else', () => {
    for (const bad of [
      '',
      '12345',
      '1234567',
      'ggg000',
      '#'.repeat(2) + '102030',
      'red',
      null,
      42,
      {},
    ]) {
      expect(normalizeHexColor(bad)).toBeNull();
    }
  });

  it('converts Wallpaper Engine "r g b" floats to hex', () => {
    expect(wallpaperEngineColorToHex('0 0 0')).toBe('000000');
    expect(wallpaperEngineColorToHex('1 1 1')).toBe('ffffff');
    expect(wallpaperEngineColorToHex('0.2 0.1 0.1')).toBe('331a1a');
    expect(wallpaperEngineColorToHex(' 0.11764 0.11764 0.18039 ')).toBe('1e1e2e');
    // out-of-range components are clamped
    expect(wallpaperEngineColorToHex('-1 2 0.5')).toBe('00ff80');
  });

  it('rejects malformed colour strings', () => {
    for (const bad of ['', '0.2 0.1', '0.2 0.1 0.1 1', 'a b c', '0.2 NaN 0.1', null, 3]) {
      expect(wallpaperEngineColorToHex(bad)).toBeNull();
    }
  });
});

describe('parseWallpaperZoom', () => {
  it('0 or less is fit (null), garbage is undefined', () => {
    expect(parseWallpaperZoom(0)).toBeNull();
    expect(parseWallpaperZoom('0')).toBeNull();
    expect(parseWallpaperZoom(-3)).toBeNull();
    expect(parseWallpaperZoom('abc')).toBeUndefined();
    expect(parseWallpaperZoom('')).toBeUndefined();
    expect(parseWallpaperZoom(null)).toBeUndefined();
    expect(parseWallpaperZoom(Infinity)).toBeUndefined();
  });

  it('rounds and clamps', () => {
    expect(parseWallpaperZoom(3)).toBe(3);
    expect(parseWallpaperZoom('3.6')).toBe(4);
    expect(parseWallpaperZoom(999)).toBe(WALLPAPER_ZOOM_MAX);
  });
});

describe('mapWallpaperEngineProps', () => {
  it('maps every known property', () => {
    expect(
      mapWallpaperEngineProps({
        showlabels: { value: false },
        chatter: { value: false },
        vignette: { value: false },
        zoom: { value: 3 },
        backgroundcolor: { value: '0.2 0.1 0.1' },
        claudeskin: { value: 'classic' },
      }),
    ).toEqual({
      labels: false,
      chatter: false,
      vignette: false,
      zoom: 3,
      bg: '331a1a',
      claudeSkin: 'classic',
    });
  });

  it('only includes the keys present (WE sends just the changed ones)', () => {
    expect(mapWallpaperEngineProps({ zoom: { value: 0 } })).toEqual({ zoom: null });
    expect(mapWallpaperEngineProps({ claudeskin: { value: 'new' } })).toEqual({
      claudeSkin: 'new',
    });
  });

  it('ignores unknown keys, malformed entries and invalid values', () => {
    expect(
      mapWallpaperEngineProps({
        schemecolor: { value: '1 0 0' },
        showlabels: true, // not { value }
        chatter: { value: 'yes' },
        zoom: { value: 'big' },
        backgroundcolor: { value: 'red' },
        claudeskin: { value: 'retro' },
      }),
    ).toEqual({});
    expect(mapWallpaperEngineProps(null)).toEqual({});
    expect(mapWallpaperEngineProps('nope')).toEqual({});
  });

  it('accepts 1/0 and "true"/"false" booleans and a hex background', () => {
    expect(
      mapWallpaperEngineProps({
        showlabels: { value: 1 },
        vignette: { value: 'false' },
        backgroundcolor: { value: '102030' },
      }),
    ).toEqual({ labels: true, vignette: false, bg: '102030' });
  });
});

describe('applySettingsPatch', () => {
  it('returns the same object when nothing changes', () => {
    const s = DEFAULT_WALLPAPER_SETTINGS;
    expect(applySettingsPatch(s, {})).toBe(s);
    expect(applySettingsPatch(s, { labels: true, zoom: null })).toBe(s);
  });

  it('returns a new object with the patch applied', () => {
    const next = applySettingsPatch(DEFAULT_WALLPAPER_SETTINGS, { zoom: 2, bg: 'ffffff' });
    expect(next).not.toBe(DEFAULT_WALLPAPER_SETTINGS);
    expect(next).toEqual({ ...DEFAULT_WALLPAPER_SETTINGS, zoom: 2, bg: 'ffffff' });
    expect(DEFAULT_WALLPAPER_SETTINGS.zoom).toBeNull();
  });
});

describe('resolveSkinId', () => {
  const has = (ids: string[]) => (id: string) => ids.includes(id);

  it('Claude (or a missing id) wears claude-classic only when chosen AND loaded', () => {
    const loaded = has(['claude', CLAUDE_CLASSIC_SKIN_ID]);
    expect(resolveSkinId('claude', 'classic', loaded)).toBe(CLAUDE_CLASSIC_SKIN_ID);
    expect(resolveSkinId(undefined, 'classic', loaded)).toBe(CLAUDE_CLASSIC_SKIN_ID);
    expect(resolveSkinId('claude', 'new', loaded)).toBe('claude');
    expect(resolveSkinId(undefined, 'new', loaded)).toBe('claude');
    expect(resolveSkinId('claude', 'classic', has(['claude']))).toBe('claude');
  });

  it('never re-skins other agent types', () => {
    const loaded = has(['codex', CLAUDE_CLASSIC_SKIN_ID]);
    expect(resolveSkinId('codex', 'classic', loaded)).toBe('codex');
    expect(resolveSkinId('gemini', 'classic', loaded)).toBe('gemini');
  });

  it('parses the choice strictly', () => {
    expect(parseClaudeSkinChoice('classic')).toBe('classic');
    expect(parseClaudeSkinChoice(' New ')).toBe('new');
    expect(parseClaudeSkinChoice('old')).toBeNull();
    expect(parseClaudeSkinChoice(undefined)).toBeNull();
  });
});

describe('Claude skin store', () => {
  it('loads the saved preference, persists changes, notifies on effective changes', () => {
    expect(getClaudeSkinPreference()).toBe('classic');
    expect(getClaudeSkin()).toBe('classic');
    let calls = 0;
    const unsub = subscribeClaudeSkin(() => calls++);
    setClaudeSkinPreference('new');
    expect(getClaudeSkin()).toBe('new');
    expect(store.get(CLAUDE_SKIN_STORAGE_KEY)).toBe('new');
    expect(calls).toBe(1);
    setClaudeSkinPreference('new'); // no change, no notify
    expect(calls).toBe(1);
    unsub();
  });

  it('the wallpaper override wins while set', () => {
    setClaudeSkinPreference('new');
    setClaudeSkinOverride('classic');
    expect(getClaudeSkin()).toBe('classic');
    expect(getClaudeSkinPreference()).toBe('new');
    setClaudeSkinOverride(null);
    expect(getClaudeSkin()).toBe('new');
  });

  it('survives a storage that throws', () => {
    const original = fakeStorage.setItem;
    fakeStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    try {
      expect(() => setClaudeSkinPreference('classic')).not.toThrow();
      expect(getClaudeSkin()).toBe('classic');
    } finally {
      fakeStorage.setItem = original;
      setClaudeSkinPreference('new');
    }
  });
});

describe('getSpritesForLook honours the Claude skin choice', () => {
  /** A minimal valid skin whose frames are `size`×`size`. */
  function skin(size: number) {
    const frame = () => Array.from({ length: size }, () => new Array<string>(size).fill(''));
    const dir = () => Array.from({ length: 7 }, frame);
    return { down: dir(), up: dir(), right: dir() };
  }
  const frontWidth = (look: Parameters<typeof getSpritesForLook>[0]) =>
    getSpritesForLook(look).walk[Direction.DOWN][0][0].length;

  it('switches existing Claude characters immediately; others are untouched', () => {
    setProviderSkins({ claude: skin(2), [CLAUDE_CLASSIC_SKIN_ID]: skin(3), codex: skin(4) });
    const claudeLook = { palette: 0, hueShift: 0, providerId: 'claude', skinHue: 0 };
    const legacyLook = { palette: 0, hueShift: 0 }; // no providerId = Claude
    const codexLook = { palette: 0, hueShift: 0, providerId: 'codex', skinHue: 0 };

    setClaudeSkinPreference('new');
    expect(frontWidth(claudeLook)).toBe(2);
    expect(frontWidth(legacyLook)).toBe(2);

    setClaudeSkinPreference('classic');
    expect(frontWidth(claudeLook)).toBe(3);
    expect(frontWidth(legacyLook)).toBe(3);
    // hue-shifted variants (2nd Claude on screen) get the classic skin too
    expect(frontWidth({ ...claudeLook, skinHue: 90 })).toBe(3);
    expect(frontWidth(codexLook)).toBe(4);

    setClaudeSkinPreference('new');
    expect(frontWidth(claudeLook)).toBe(2);
  });

  it('falls back to the claude skin when claude-classic is not loaded', () => {
    setProviderSkins({ claude: skin(2) });
    setClaudeSkinPreference('classic');
    expect(frontWidth({ palette: 0, hueShift: 0, providerId: 'claude' })).toBe(2);
    setClaudeSkinPreference('new');
  });
});

describe('wallpaper settings store + wallpaperPropertyListener', () => {
  it('seeds from the URL, applies WE properties live, ignores junk', () => {
    const g = globalThis as {
      wallpaperPropertyListener?: {
        applyUserProperties: (p: unknown) => void;
        setPaused?: unknown;
      };
    };
    const setPaused = () => {};
    g.wallpaperPropertyListener = { applyUserProperties: () => {}, setPaused };
    setClaudeSkinPreference('new');

    initWallpaperSettings(
      parseWallpaperParams('?wallpaper=1&bg=102030&chatter=0&claudeSkin=classic&vignette=0'),
    );
    expect(getWallpaperSettings()).toEqual({
      labels: true,
      chatter: false,
      zoom: null,
      bg: '102030',
      claudeSkin: 'classic',
      vignette: false,
    });
    // the wallpaper's skin wins over the saved preference
    expect(getClaudeSkin()).toBe('classic');
    // other listener fields are kept
    expect(g.wallpaperPropertyListener?.setPaused).toBe(setPaused);

    let calls = 0;
    const unsub = subscribeWallpaperSettings(() => calls++);
    g.wallpaperPropertyListener!.applyUserProperties({
      showlabels: { value: false },
      backgroundcolor: { value: '0.2 0.1 0.1' },
      claudeskin: { value: 'new' },
      zoom: { value: 2 },
    });
    expect(calls).toBe(1);
    expect(getWallpaperSettings()).toEqual({
      labels: false,
      chatter: false,
      zoom: 2,
      bg: '331a1a',
      claudeSkin: 'new',
      vignette: false,
    });
    expect(getClaudeSkin()).toBe('new');

    const before = getWallpaperSettings();
    g.wallpaperPropertyListener!.applyUserProperties({ unknownthing: { value: 1 } });
    g.wallpaperPropertyListener!.applyUserProperties(undefined);
    g.wallpaperPropertyListener!.applyUserProperties({ zoom: { value: 2 } }); // unchanged
    expect(getWallpaperSettings()).toBe(before);
    expect(calls).toBe(1);

    g.wallpaperPropertyListener!.applyUserProperties({ zoom: { value: 0 } });
    expect(getWallpaperSettings().zoom).toBeNull();
    unsub();
  });
});
