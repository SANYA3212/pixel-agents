import { getClaudeSkin, resolveSkinId } from '../../claudeSkin.js';
import type { ColorValue } from '../../components/ui/types.js';
import { DEFAULT_PROVIDER_ID, PALETTE_COUNT } from '../../constants.js';
import { adjustSprite } from '../colorize.js';
import type { Direction, SpriteData } from '../types.js';
import { Direction as Dir } from '../types.js';
import bubblePermissionData from './bubble-permission.json';
import bubblePetData from './bubble-pet.json';
import bubbleWaitingData from './bubble-waiting.json';

// ── Speech Bubble Sprites ───────────────────────────────────────

interface BubbleSpriteJson {
  palette: Record<string, string>;
  pixels: string[][];
}

function resolveBubbleSprite(data: BubbleSpriteJson): SpriteData {
  return data.pixels.map((row) => row.map((key) => data.palette[key] ?? key));
}

/** Permission bubble: white square with "..." in amber, and a tail pointer (11x13) */
export const BUBBLE_PERMISSION_SPRITE: SpriteData = resolveBubbleSprite(bubblePermissionData);

/** Waiting bubble: white square with green checkmark, and a tail pointer (11x13) */
export const BUBBLE_WAITING_SPRITE: SpriteData = resolveBubbleSprite(bubbleWaitingData);

/** Heart bubble: pet petting feedback (11x13) */
export const BUBBLE_HEART_SPRITE: SpriteData = resolveBubbleSprite(bubblePetData);

// ════════════════════════════════════════════════════════════════
// Loaded character sprites (from PNG assets)
// ════════════════════════════════════════════════════════════════

interface LoadedCharacterData {
  down: SpriteData[];
  up: SpriteData[];
  right: SpriteData[];
}

let loadedCharacters: LoadedCharacterData[] | null = null;

/** Set pre-colored character sprites loaded from PNG assets. Call this when characterSpritesLoaded message arrives. */
export function setCharacterTemplates(data: LoadedCharacterData[]): void {
  loadedCharacters = data;
  // Clear cache so sprites are rebuilt from loaded data
  spriteCache.clear();
}

// ── Per-agent-type skins (providerSkins) ─────────────────────────

/** Frames each direction row of a character sheet must carry
 *  (walk1, walk2, walk3, type1, type2, read1, read2). */
const SKIN_FRAMES_PER_DIRECTION = 7;

let providerSkins: Map<string, LoadedCharacterData> = new Map();

function isValidSkin(set: unknown): set is LoadedCharacterData {
  if (!set || typeof set !== 'object') return false;
  const s = set as Record<string, unknown>;
  for (const dir of ['down', 'up', 'right']) {
    const frames = s[dir];
    if (!Array.isArray(frames) || frames.length < SKIN_FRAMES_PER_DIRECTION) return false;
    for (const f of frames.slice(0, SKIN_FRAMES_PER_DIRECTION)) {
      if (!Array.isArray(f) || f.length === 0 || !Array.isArray(f[0])) return false;
    }
  }
  return true;
}

/** Store the per-agent-type skins from `characterSpritesLoaded.providerSkins`.
 *  Malformed entries are skipped; an absent record clears the skins. */
export function setProviderSkins(skins: Record<string, unknown> | undefined | null): void {
  const next = new Map<string, LoadedCharacterData>();
  if (skins && typeof skins === 'object') {
    for (const [providerId, set] of Object.entries(skins)) {
      if (isValidSkin(set)) next.set(providerId, set);
    }
  }
  providerSkins = next;
  spriteCache.clear();
}

/** Whether a dedicated skin is loaded for this agent type. */
export function hasProviderSkin(providerId: string | undefined): boolean {
  return providerSkins.has(providerId ?? DEFAULT_PROVIDER_ID);
}

/** Agent types that have a loaded skin. */
export function getProviderSkinIds(): string[] {
  return [...providerSkins.keys()];
}

/** Return the number of loaded character palettes, or PALETTE_COUNT as fallback. */
export function getLoadedCharacterCount(): number {
  return loadedCharacters ? loadedCharacters.length : PALETTE_COUNT;
}

/** Flip a SpriteData horizontally (for generating left sprites from right) */
function flipSpriteHorizontal(sprite: SpriteData): SpriteData {
  return sprite.map((row) => [...row].reverse());
}

// ════════════════════════════════════════════════════════════════
// Sprite resolution + caching
// ════════════════════════════════════════════════════════════════

export interface CharacterSprites {
  walk: Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>;
  typing: Record<Direction, [SpriteData, SpriteData]>;
  reading: Record<Direction, [SpriteData, SpriteData]>;
}

const spriteCache = new Map<string, CharacterSprites>();

/** Apply hue shift to every sprite in a CharacterSprites set */
function hueShiftSprites(sprites: CharacterSprites, hueShift: number): CharacterSprites {
  const color: ColorValue = { h: hueShift, s: 0, b: 0, c: 0 };
  const shift = (s: SpriteData) => adjustSprite(s, color);
  const shiftWalk = (
    arr: [SpriteData, SpriteData, SpriteData, SpriteData],
  ): [SpriteData, SpriteData, SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
    shift(arr[2]),
    shift(arr[3]),
  ];
  const shiftPair = (arr: [SpriteData, SpriteData]): [SpriteData, SpriteData] => [
    shift(arr[0]),
    shift(arr[1]),
  ];
  return {
    walk: {
      [Dir.DOWN]: shiftWalk(sprites.walk[Dir.DOWN]),
      [Dir.UP]: shiftWalk(sprites.walk[Dir.UP]),
      [Dir.RIGHT]: shiftWalk(sprites.walk[Dir.RIGHT]),
      [Dir.LEFT]: shiftWalk(sprites.walk[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData, SpriteData, SpriteData]>,
    typing: {
      [Dir.DOWN]: shiftPair(sprites.typing[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.typing[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.typing[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.typing[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
    reading: {
      [Dir.DOWN]: shiftPair(sprites.reading[Dir.DOWN]),
      [Dir.UP]: shiftPair(sprites.reading[Dir.UP]),
      [Dir.RIGHT]: shiftPair(sprites.reading[Dir.RIGHT]),
      [Dir.LEFT]: shiftPair(sprites.reading[Dir.LEFT]),
    } as Record<Direction, [SpriteData, SpriteData]>,
  };
}

/** Create a transparent placeholder sprite of given dimensions */
function emptySprite(w: number, h: number): SpriteData {
  const rows: string[][] = [];
  for (let y = 0; y < h; y++) {
    rows.push(new Array(w).fill(''));
  }
  return rows;
}

function buildSprites(char: LoadedCharacterData): CharacterSprites {
  const d = char.down;
  const u = char.up;
  const rt = char.right;
  const flip = flipSpriteHorizontal;
  return {
    walk: {
      [Dir.DOWN]: [d[0], d[1], d[2], d[1]],
      [Dir.UP]: [u[0], u[1], u[2], u[1]],
      [Dir.RIGHT]: [rt[0], rt[1], rt[2], rt[1]],
      [Dir.LEFT]: [flip(rt[0]), flip(rt[1]), flip(rt[2]), flip(rt[1])],
    },
    typing: {
      [Dir.DOWN]: [d[3], d[4]],
      [Dir.UP]: [u[3], u[4]],
      [Dir.RIGHT]: [rt[3], rt[4]],
      [Dir.LEFT]: [flip(rt[3]), flip(rt[4])],
    },
    reading: {
      [Dir.DOWN]: [d[5], d[6]],
      [Dir.UP]: [u[5], u[6]],
      [Dir.RIGHT]: [rt[5], rt[6]],
      [Dir.LEFT]: [flip(rt[5]), flip(rt[6])],
    },
  };
}

function placeholderSprites(): CharacterSprites {
  // Fallback: transparent placeholder sprites (16×32)
  const e = emptySprite(16, 32);
  const walkSet: [SpriteData, SpriteData, SpriteData, SpriteData] = [e, e, e, e];
  const pairSet: [SpriteData, SpriteData] = [e, e];
  return {
    walk: {
      [Dir.DOWN]: walkSet,
      [Dir.UP]: walkSet,
      [Dir.RIGHT]: walkSet,
      [Dir.LEFT]: walkSet,
    },
    typing: {
      [Dir.DOWN]: pairSet,
      [Dir.UP]: pairSet,
      [Dir.RIGHT]: pairSet,
      [Dir.LEFT]: pairSet,
    },
    reading: {
      [Dir.DOWN]: pairSet,
      [Dir.UP]: pairSet,
      [Dir.RIGHT]: pairSet,
      [Dir.LEFT]: pairSet,
    },
  };
}

export function getCharacterSprites(paletteIndex: number, hueShift = 0): CharacterSprites {
  const cacheKey = `${paletteIndex}:${hueShift}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;

  // Use pre-colored character sprites directly (no palette swapping)
  let sprites = loadedCharacters
    ? buildSprites(loadedCharacters[paletteIndex % loadedCharacters.length])
    : placeholderSprites();

  // Apply hue shift if non-zero
  if (hueShift !== 0) {
    sprites = hueShiftSprites(sprites, hueShift);
  }

  spriteCache.set(cacheKey, sprites);
  return sprites;
}

/** Sprites of an agent type's own skin, hue-shifted by `skinHue`. Cached under
 *  `skin:<provider>:<hue>` (the palette cache uses `<palette>:<hue>`, so the
 *  two never collide). Returns null when that type has no skin loaded. */
export function getProviderSkinSprites(providerId: string, skinHue = 0): CharacterSprites | null {
  const skin = providerSkins.get(providerId);
  if (!skin) return null;
  const cacheKey = `skin:${providerId}:${skinHue}`;
  const cached = spriteCache.get(cacheKey);
  if (cached) return cached;
  let sprites = buildSprites(skin);
  if (skinHue !== 0) sprites = hueShiftSprites(sprites, skinHue);
  spriteCache.set(cacheKey, sprites);
  return sprites;
}

/** What a character looks like: its agent type's skin when one is loaded,
 *  otherwise the palette sprites (the pre-skin behaviour). Claude characters
 *  wear `claude-classic` instead while that is the chosen Claude skin (see
 *  claudeSkin.ts); the choice is read on every call, so a change re-skins
 *  every character on the next frame (the caches are keyed by skin id). */
export interface CharacterLook {
  palette: number;
  hueShift: number;
  providerId?: string;
  skinHue?: number;
}

export function getSpritesForLook(look: CharacterLook): CharacterSprites {
  const skinId = resolveSkinId(look.providerId, getClaudeSkin(), (id) => providerSkins.has(id));
  const skin = getProviderSkinSprites(skinId, look.skinHue ?? 0);
  return skin ?? getCharacterSprites(look.palette, look.hueShift);
}
