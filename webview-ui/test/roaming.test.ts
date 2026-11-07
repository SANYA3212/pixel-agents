/**
 * Free roaming: an agent with no task wanders the office indefinitely and
 * only goes to its seat to work.
 *
 * Covers the pure target picker (roaming.ts) and the character FSM decisions
 * that changed (characters.ts): idle never returns to the seat on its own any
 * more, a task walks the character to its seat, the end of a turn stands it
 * up after a short delay.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  ROAM_PAUSE_MAX_SEC,
  ROAM_PAUSE_MIN_SEC,
  STAND_UP_DELAY_MAX_SEC,
  STAND_UP_DELAY_MIN_SEC,
} from '../src/constants.js';
import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  isIdleStanding,
  isRoaming,
  occupiedTiles,
  pickRoamTargets,
  roamPause,
  standUpDelay,
} from '../src/office/engine/roaming.js';
import { getWalkableTiles } from '../src/office/layout/tileMap.js';
import type { Character, OfficeLayout, Seat } from '../src/office/types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../src/office/types.js';

/** Deterministic rng cycling through `values`. */
function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function floorMap(cols: number, rows: number): TileType[][] {
  return Array.from({ length: rows }, () => new Array<TileType>(cols).fill(TileType.FLOOR_1));
}

function idleAt(id: number, col: number, row: number): Character {
  const ch = createCharacter(id, 0, null, null);
  ch.state = CharacterState.IDLE;
  ch.isActive = false;
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  return ch;
}

describe('roaming eligibility', () => {
  test('roaming = no task, not seated, not materializing', () => {
    const ch = idleAt(1, 2, 2);
    assert.equal(isRoaming(ch), true);
    assert.equal(isIdleStanding(ch), true);
    ch.isActive = true;
    assert.equal(isRoaming(ch), false);
    ch.isActive = false;
    ch.state = CharacterState.TYPE;
    assert.equal(isRoaming(ch), false);
    ch.state = CharacterState.WALK;
    ch.path = [{ col: 3, row: 2 }];
    assert.equal(isRoaming(ch), true);
    assert.equal(isIdleStanding(ch), false, 'a walker is not a standing target');
    ch.state = CharacterState.IDLE;
    ch.path = [];
    ch.matrixEffect = 'spawn';
    assert.equal(isRoaming(ch), false);
  });

  test('occupiedTiles covers positions and walk destinations, except self', () => {
    const a = idleAt(1, 1, 1);
    const b = idleAt(2, 4, 4);
    b.path = [
      { col: 5, row: 4 },
      { col: 6, row: 4 },
    ];
    const occ = occupiedTiles([a, b], 1);
    assert.equal(occ.has('1,1'), false);
    assert.equal(occ.has('4,4'), true);
    assert.equal(occ.has('6,4'), true);
  });
});

describe('pickRoamTargets', () => {
  const walkable = getWalkableTiles(floorMap(10, 10), new Set());

  test('social walk: heads for a free tile next to an idle standing character', () => {
    const self = idleAt(1, 0, 0);
    const partner = idleAt(2, 7, 7);
    // rng: 0.1 < ROAM_SOCIAL_CHANCE → social; then partner pick + tie-breaks.
    const targets = pickRoamTargets(self, walkable, [self, partner], new Set(['7,7']), seq(0.1));
    assert.ok(targets.length > 0);
    const first = targets[0];
    const d = Math.abs(first.col - 7) + Math.abs(first.row - 7);
    assert.equal(d, 1, 'the closest spot (face to face) comes first');
  });

  test('no social walk toward a character that is walking or working', () => {
    const self = idleAt(1, 0, 0);
    const busy = idleAt(2, 7, 7);
    busy.isActive = true;
    // rng 0.1 always: the social roll passes, but there is no idle partner, so
    // only the random samples remain (all land on tile index 10 = (0,1)).
    const targets = pickRoamTargets(self, walkable, [self, busy], new Set(), seq(0.1));
    assert.ok(targets.length > 0);
    for (const t of targets) {
      const d = Math.abs(t.col - 7) + Math.abs(t.row - 7);
      assert.ok(d > 2, `unexpected social target ${t.col},${t.row}`);
    }
  });

  test('plain walk prefers far destinations and never an occupied tile', () => {
    const self = idleAt(1, 0, 0);
    // rng 0.9 → not social; samples: 0.01 → tile 0 (=self tile, skipped),
    // 0.5 → tile 50 (5,0)... far; 0.12 → tile 12 (2,1) close.
    const occupied = new Set(['5,0']);
    const targets = pickRoamTargets(
      self,
      walkable,
      [self],
      occupied,
      seq(0.9, 0.01, 0.5, 0.12, 0.99),
    );
    assert.ok(targets.length > 0);
    assert.ok(!targets.some((t) => t.col === 0 && t.row === 0), 'never the current tile');
    assert.ok(!targets.some((t) => t.col === 5 && t.row === 0), 'never an occupied tile');
    const firstD = targets[0].col + targets[0].row;
    const lastD = targets[targets.length - 1].col + targets[targets.length - 1].row;
    assert.ok(firstD >= lastD, 'far candidates come before close ones');
  });

  test('nowhere to go → no candidates', () => {
    assert.deepEqual(pickRoamTargets(idleAt(1, 0, 0), [], [], new Set()), []);
  });

  test('pauses and stand-up delays stay within their ranges', () => {
    for (const r of [0, 0.5, 0.999]) {
      const p = roamPause(() => r);
      assert.ok(p >= ROAM_PAUSE_MIN_SEC && p <= ROAM_PAUSE_MAX_SEC);
      const s = standUpDelay(() => r);
      assert.ok(s >= STAND_UP_DELAY_MIN_SEC && s <= STAND_UP_DELAY_MAX_SEC);
    }
  });
});

describe('character FSM: roam while idle, sit to work', () => {
  const tileMap = floorMap(10, 8);
  const walkable = getWalkableTiles(tileMap, new Set());
  const seat: Seat = { uid: 's1', seatCol: 8, seatRow: 6, facingDir: Direction.UP, assigned: true };
  const seats = new Map([['s1', seat]]);

  test('an idle character keeps roaming and never returns to its seat on its own', () => {
    const ch = createCharacter(1, 0, 's1', seat);
    ch.isActive = false;
    ch.state = CharacterState.IDLE;
    ch.tileCol = 1;
    ch.tileRow = 1;
    ch.x = 1.5 * TILE_SIZE;
    ch.y = 1.5 * TILE_SIZE;
    // As in OfficeState: seat tiles are not roaming destinations (walkableTiles
    // is built with chairs blocked), though the own seat stays pathable.
    const roamable = getWalkableTiles(tileMap, new Set(['8,6']));
    let walks = 0;
    let wasWalking = false;
    // Ten simulated minutes at 10 fps.
    for (let i = 0; i < 6000; i++) {
      updateCharacter(ch, 0.1, roamable, seats, tileMap, new Set());
      const state: string = ch.state; // re-read: the FSM mutates it
      assert.notEqual(state, CharacterState.TYPE, `sat down at step ${i}`);
      const walking = state === CharacterState.WALK;
      if (walking && !wasWalking) walks++;
      wasWalking = walking;
    }
    // The old FSM went back to the seat after 3–6 wander moves.
    assert.ok(walks > 20, `expected plenty of roaming walks, got ${walks}`);
  });

  test('a task walks the roaming character to its seat, where it types', () => {
    const ch = createCharacter(1, 0, 's1', seat);
    ch.isActive = true;
    ch.state = CharacterState.IDLE;
    ch.tileCol = 1;
    ch.tileRow = 1;
    ch.x = 1.5 * TILE_SIZE;
    ch.y = 1.5 * TILE_SIZE;
    const stateOf = (c: Character): string => c.state;
    for (let i = 0; i < 400 && stateOf(ch) !== CharacterState.TYPE; i++) {
      updateCharacter(ch, 0.05, walkable, seats, tileMap, new Set());
    }
    assert.equal(ch.state, CharacterState.TYPE);
    assert.equal(ch.tileCol, 8);
    assert.equal(ch.tileRow, 6);
    assert.equal(ch.dir, Direction.UP);
  });

  test('the roam picker decides where an idle character walks', () => {
    const ch = idleAt(1, 2, 2);
    ch.wanderTimer = 0;
    updateCharacter(ch, 0.1, walkable, seats, tileMap, new Set(), () => [{ col: 5, row: 2 }]);
    assert.equal(ch.state, CharacterState.WALK);
    assert.deepEqual(ch.path[ch.path.length - 1], { col: 5, row: 2 });
  });

  test('an unreachable first candidate falls through to the next one', () => {
    const ch = idleAt(1, 2, 2);
    ch.wanderTimer = 0;
    const blocked = new Set(['9,7']);
    updateCharacter(ch, 0.1, walkable, seats, tileMap, blocked, () => [
      { col: 9, row: 7 },
      { col: 2, row: 5 },
    ]);
    assert.deepEqual(ch.path[ch.path.length - 1], { col: 2, row: 5 });
  });
});

describe('OfficeState: end of a turn', () => {
  function floorLayout(cols = 9, rows = 7): OfficeLayout {
    return {
      version: 1,
      cols,
      rows,
      tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
      furniture: [],
    };
  }

  test('a seated agent stays a moment after its turn ends, then stands up and roams', () => {
    const os = new OfficeState(floorLayout());
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    assert.equal(ch.state, CharacterState.TYPE, 'new agents start at work');
    os.setAgentActive(1, false);
    assert.ok(ch.seatTimer >= STAND_UP_DELAY_MIN_SEC, 'a short stand-up delay is set');
    os.update(0.5);
    assert.equal(ch.state, CharacterState.TYPE, 'still seated during the delay');
    for (let i = 0; i < 40; i++) os.update(0.1);
    assert.notEqual(ch.state, CharacterState.TYPE, 'stood up after the delay');
  });

  test('a repeated idle status does not freeze a roaming character mid-walk', () => {
    const os = new OfficeState(floorLayout());
    os.addAgent(1, 0, 0, undefined, true);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, false);
    ch.state = CharacterState.WALK;
    ch.path = [{ col: 3, row: 3 }];
    os.setAgentActive(1, false);
    assert.equal(ch.path.length, 1, 'path kept: the turn had already ended');
  });
});
