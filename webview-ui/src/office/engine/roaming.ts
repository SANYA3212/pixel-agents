// webview-ui/src/office/engine/roaming.ts
//
// Pure decisions for free roaming: an agent with no task (idle / waiting /
// done), a sub-agent between tools, or an unbound Resident walks the office
// indefinitely — random destinations, natural pauses, and now and then a walk
// that ends next to another idle character (where the chatter system may start
// a conversation). The FSM in characters.ts asks these functions; OfficeState
// supplies the live world. Random sources are injected so tests are exact.

import {
  ROAM_MIN_DISTANCE_TILES,
  ROAM_PAUSE_MAX_SEC,
  ROAM_PAUSE_MIN_SEC,
  ROAM_SOCIAL_CHANCE,
  ROAM_SOCIAL_MAX_DISTANCE_TILES,
  ROAM_TARGET_SAMPLES,
  STAND_UP_DELAY_MAX_SEC,
  STAND_UP_DELAY_MIN_SEC,
} from '../../constants.js';
import { CharacterState } from '../types.js';

export interface Tile {
  col: number;
  row: number;
}

/** The parts of a character the roaming rules read. */
export interface RoamActor {
  id: number;
  tileCol: number;
  tileRow: number;
  state: string;
  isActive: boolean;
  matrixEffect: 'spawn' | 'despawn' | null;
  path: Tile[];
}

/** Whether a character is free to roam: no task, not sitting, not materializing. */
export function isRoaming(ch: RoamActor): boolean {
  return !ch.isActive && ch.state !== CharacterState.TYPE && ch.matrixEffect === null;
}

/** A roaming character standing still — a target worth walking up to. */
export function isIdleStanding(ch: RoamActor): boolean {
  return isRoaming(ch) && ch.state === CharacterState.IDLE && ch.path.length === 0;
}

function manhattan(a: Tile, b: Tile): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

const key = (t: Tile): string => `${t.col},${t.row}`;

/**
 * Tiles other characters stand on or are walking to: a roaming walk never
 * ends on top of somebody.
 */
export function occupiedTiles(chars: Iterable<RoamActor>, exceptId?: number): Set<string> {
  const out = new Set<string>();
  for (const ch of chars) {
    if (ch.id === exceptId) continue;
    out.add(`${ch.tileCol},${ch.tileRow}`);
    const last = ch.path[ch.path.length - 1];
    if (last) out.add(key(last));
  }
  return out;
}

/**
 * Pick where a roaming character walks next.
 *
 * With ROAM_SOCIAL_CHANCE it heads for a free tile within
 * ROAM_SOCIAL_MAX_DISTANCE_TILES of another idle, standing character (so the
 * two can chat). Otherwise it samples ROAM_TARGET_SAMPLES random walkable tiles
 * and takes the first one at least ROAM_MIN_DISTANCE_TILES away, falling back
 * to any sampled free tile. Returns candidates in preference order (the caller
 * walks to the first one it can path to); empty when there is nowhere to go.
 */
export function pickRoamTargets(
  self: RoamActor,
  walkable: readonly Tile[],
  others: Iterable<RoamActor>,
  occupied: Set<string>,
  rng: () => number = Math.random,
): Tile[] {
  if (walkable.length === 0) return [];
  const here: Tile = { col: self.tileCol, row: self.tileRow };
  const free = (t: Tile) => !occupied.has(key(t)) && !(t.col === here.col && t.row === here.row);
  const out: Tile[] = [];

  if (rng() < ROAM_SOCIAL_CHANCE) {
    const partners: RoamActor[] = [];
    for (const o of others) {
      if (o.id !== self.id && isIdleStanding(o)) partners.push(o);
    }
    if (partners.length > 0) {
      const p = partners[Math.floor(rng() * partners.length)];
      const at: Tile = { col: p.tileCol, row: p.tileRow };
      // Closest spots first (face-to-face beats two tiles apart), random among equals.
      const near = walkable
        .filter((t) => {
          const d = manhattan(t, at);
          return d >= 1 && d <= ROAM_SOCIAL_MAX_DISTANCE_TILES && free(t);
        })
        .map((t) => ({ t, d: manhattan(t, at), r: rng() }))
        .sort((a, b) => a.d - b.d || a.r - b.r);
      out.push(...near.slice(0, 3).map((n) => n.t));
    }
  }

  const far: Tile[] = [];
  const close: Tile[] = [];
  for (let i = 0; i < ROAM_TARGET_SAMPLES; i++) {
    const t = walkable[Math.floor(rng() * walkable.length)];
    if (!free(t)) continue;
    (manhattan(t, here) >= ROAM_MIN_DISTANCE_TILES ? far : close).push(t);
  }
  out.push(...far, ...close);
  return out;
}

function range(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min);
}

/** Pause before the next roaming walk. */
export function roamPause(rng: () => number = Math.random): number {
  return range(ROAM_PAUSE_MIN_SEC, ROAM_PAUSE_MAX_SEC, rng);
}

/** How long an agent stays seated after its turn ends before getting up. */
export function standUpDelay(rng: () => number = Math.random): number {
  return range(STAND_UP_DELAY_MIN_SEC, STAND_UP_DELAY_MAX_SEC, rng);
}
