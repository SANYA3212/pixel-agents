/**
 * Residents: characters added in the browser that roam the office and become
 * the body of a matching agent while it runs.
 *
 * Covers the pure rules (residents.ts: roster sanitizing, which resident an
 * agent takes, skin hues, labels) and the OfficeState model: binding re-keys
 * the resident's character under the agent id (so everything keyed by agent
 * id keeps working), closing the agent hands it back to the roster instead of
 * despawning it, and the roster round-trips through `layout.residents`
 * without ever riding the layout editor's undo.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, describe, test } from 'vitest';

import { MAX_RESIDENT_NAME_LENGTH, MAX_RESIDENTS, SKIN_HUE_STEPS } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  characterDisplayLabel,
  chooseResidentForAgent,
  fallbackPaletteFor,
  newResidentId,
  normalizeProviderId,
  pickSkinHue,
  residentDisplayName,
  sanitizeResidentName,
  sanitizeResidents,
} from '../src/office/engine/residents.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, MATRIX_EFFECT_DURATION, TileType } from '../src/office/types.js';

beforeAll(() => {
  const catalog: LoadedAssetData['catalog'] = [
    {
      id: 'TEST_CHAIR',
      label: 'Chair',
      category: 'chairs',
      width: 16,
      height: 16,
      footprintW: 1,
      footprintH: 1,
      isDesk: false,
    },
  ];
  assert.ok(buildDynamicCatalog({ catalog, sprites: { TEST_CHAIR: [['']] } }));
});

function layoutWith(furniture: PlacedFurniture[] = [], cols = 10, rows = 8): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture,
  };
}

const chairs = (n: number): PlacedFurniture[] =>
  Array.from({ length: n }, (_, i) => ({
    uid: `chair-${i}`,
    type: 'TEST_CHAIR',
    col: 1 + i * 2,
    row: 6,
  }));

/** Run the office until every matrix effect has finished. */
function settle(os: OfficeState): void {
  for (let t = 0; t <= MATRIX_EFFECT_DURATION + 0.2; t += 0.05) os.update(0.05);
}

// ── Pure rules ─────────────────────────────────────────────────

describe('residents: pure rules', () => {
  test('normalizeProviderId: missing/garbled → claude, known/new slugs pass', () => {
    assert.equal(normalizeProviderId(undefined), 'claude');
    assert.equal(normalizeProviderId(''), 'claude');
    assert.equal(normalizeProviderId('codex'), 'codex');
    assert.equal(normalizeProviderId('Kimi'), 'kimi');
    assert.equal(normalizeProviderId('future-agent'), 'future-agent');
    assert.equal(normalizeProviderId('<script>'), 'claude');
    assert.equal(normalizeProviderId(42), 'claude');
  });

  test('sanitizeResidents drops junk and duplicates, keeps order and names', () => {
    const raw = [
      { id: 'a', providerId: 'codex', name: '  Rex  ' },
      { id: 'a', providerId: 'kimi' }, // duplicate id
      { providerId: 'kimi' }, // no id
      'nope',
      null,
      { id: 'b', providerId: 'weird id!' },
      { id: 'c', providerId: 'gemini', name: '' },
      { id: 'x'.repeat(200), providerId: 'qwen' }, // id too long
    ];
    assert.deepEqual(sanitizeResidents(raw), [
      { id: 'a', providerId: 'codex', name: 'Rex' },
      { id: 'b', providerId: 'claude' },
      { id: 'c', providerId: 'gemini' },
    ]);
    assert.deepEqual(sanitizeResidents(undefined), []);
    assert.deepEqual(sanitizeResidents({ id: 'a' }), []);
    const many = Array.from({ length: MAX_RESIDENTS + 5 }, (_, i) => ({
      id: `r${i}`,
      providerId: 'codex',
    }));
    assert.equal(sanitizeResidents(many).length, MAX_RESIDENTS);
  });

  test('sanitizeResidentName trims, strips control characters and caps the length', () => {
    assert.equal(sanitizeResidentName('  Ada\n'), 'Ada');
    assert.equal(sanitizeResidentName('a\u0007b'), 'ab');
    assert.equal(sanitizeResidentName('   '), undefined);
    assert.equal(sanitizeResidentName(5), undefined);
    assert.equal(sanitizeResidentName('x'.repeat(100))!.length, MAX_RESIDENT_NAME_LENGTH);
  });

  test('chooseResidentForAgent: first free resident of the same type', () => {
    const roster = [
      { id: 'r1', providerId: 'codex', boundAgentId: 7 },
      { id: 'r2', providerId: 'kimi', boundAgentId: null },
      { id: 'r3', providerId: 'codex', boundAgentId: null },
      { id: 'r4', providerId: 'codex', boundAgentId: null },
    ];
    assert.equal(chooseResidentForAgent(roster, 'codex')?.id, 'r3');
    assert.equal(chooseResidentForAgent(roster, 'kimi')?.id, 'r2');
    assert.equal(chooseResidentForAgent(roster, 'gemini'), null);
    assert.equal(chooseResidentForAgent(roster, undefined), null, 'absent = claude, none here');
  });

  test('pickSkinHue: the first of a type keeps the skin, the next ones get distinct steps', () => {
    assert.equal(pickSkinHue([]), 0);
    assert.equal(pickSkinHue([0]), SKIN_HUE_STEPS[1]);
    assert.equal(pickSkinHue([0, SKIN_HUE_STEPS[1]]), SKIN_HUE_STEPS[2]);
    assert.equal(pickSkinHue([SKIN_HUE_STEPS[1]]), 0, 'a freed slot is reused');
    const all = pickSkinHue(SKIN_HUE_STEPS, () => 0.5);
    assert.ok(all > 0 && all < 360);
  });

  test('fallbackPaletteFor is stable per type and within range', () => {
    assert.equal(fallbackPaletteFor('claude', 6), 0);
    assert.equal(fallbackPaletteFor('codex', 6), 1);
    assert.equal(fallbackPaletteFor('cursor', 6), 7 % 6);
    const p = fallbackPaletteFor('someday', 6);
    assert.ok(p >= 0 && p < 6);
    assert.equal(fallbackPaletteFor('someday', 6), p);
  });

  test('labels', () => {
    assert.equal(characterDisplayLabel({}), undefined);
    assert.equal(characterDisplayLabel({ agentLabel: 'Codex · app' }), 'Codex · app');
    assert.equal(characterDisplayLabel({ residentName: 'Rex' }), 'Rex');
    assert.equal(
      characterDisplayLabel({ residentName: 'Rex', agentLabel: 'Codex · app' }),
      'Rex · Codex · app',
    );
    assert.equal(residentDisplayName({ providerId: 'opencode' }), 'OpenCode resident');
    assert.equal(residentDisplayName({ providerId: 'opencode', name: 'Oz' }), 'Oz');
  });

  test('newResidentId never collides in practice', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newResidentId()));
    assert.equal(ids.size, 200);
  });
});

// ── OfficeState: binding ───────────────────────────────────────

describe('residents: binding to agents', () => {
  test('a resident roams under its own id and is not an agent', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    const rid = os.addResident('codex', 'Rex')!;
    const [info] = os.getResidents();
    assert.equal(info.id, rid);
    assert.equal(info.boundAgentId, null);
    assert.ok(info.characterId < 0, 'reserved negative id');
    const ch = os.characters.get(info.characterId)!;
    assert.equal(ch.residentId, rid);
    assert.equal(ch.residentName, 'Rex');
    assert.equal(ch.providerId, 'codex');
    assert.equal(ch.isActive, false);
    assert.equal(ch.seatId, null, 'free residents own no seat');
    assert.equal(ch.matrixEffect, 'spawn', 'added in the browser → spawn effect');
    assert.equal(os.isUnboundResident(info.characterId), true);
    assert.deepEqual(os.getPersistableSeats(), {}, 'never persisted as an agent seat');
  });

  test('an agent of the same type takes the resident as its body', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    os.addResident('codex', 'Rex');
    settle(os);
    const homeId = os.getResidents()[0].characterId;
    const body = os.characters.get(homeId)!;
    os.selectedAgentId = homeId;
    os.cameraFollowId = homeId;

    os.addAgent(5, undefined, undefined, undefined, false, 'app', undefined, {
      providerId: 'codex',
      agentLabel: 'Codex · app',
    });

    assert.equal(os.characters.has(homeId), false, 're-keyed, not copied');
    assert.equal(os.characters.get(5), body, 'the very same character object');
    assert.equal(body.id, 5);
    assert.equal(body.matrixEffect, null, 'no new spawn');
    assert.equal(body.isActive, true, 'heads to work');
    assert.ok(body.seatId, 'got a seat');
    assert.equal(body.agentLabel, 'Codex · app');
    assert.equal(body.directoryName, 'app');
    assert.equal(os.selectedAgentId, 5, 'selection follows the character');
    assert.equal(os.cameraFollowId, 5);
    assert.equal(os.getResidents()[0].boundAgentId, 5);
    assert.equal(os.isUnboundResident(5), false);
    assert.deepEqual(Object.keys(os.getPersistableSeats()), ['5']);

    // It walks to the seat and sits.
    for (let i = 0; i < 400 && body.state !== CharacterState.TYPE; i++) os.update(0.05);
    assert.equal(body.state, CharacterState.TYPE);
    const seat = os.seats.get(body.seatId!)!;
    assert.deepEqual([body.tileCol, body.tileRow], [seat.seatCol, seat.seatRow]);
  });

  test('no free resident of that type → the agent gets its own character, as before', () => {
    const os = new OfficeState(layoutWith(chairs(3)));
    os.addResident('codex');
    os.addAgent(1, undefined, undefined, undefined, true, undefined, undefined, {
      providerId: 'kimi',
    });
    os.addAgent(2, undefined, undefined, undefined, true); // absent provider = claude
    assert.equal(os.characters.get(1)!.residentId, undefined);
    assert.equal(os.characters.get(1)!.providerId, 'kimi');
    assert.equal(os.characters.get(2)!.providerId, 'claude');
    assert.equal(os.getResidents()[0].boundAgentId, null, 'the codex resident stays free');
  });

  test('two agents, one resident: only the first binds', () => {
    const os = new OfficeState(layoutWith(chairs(3)));
    os.addResident('codex');
    const opts = { providerId: 'codex' };
    os.addAgent(1, undefined, undefined, undefined, true, undefined, undefined, opts);
    os.addAgent(2, undefined, undefined, undefined, true, undefined, undefined, opts);
    assert.ok(os.characters.get(1)!.residentId);
    assert.equal(os.characters.get(2)!.residentId, undefined);
    assert.notEqual(
      os.characters.get(1)!.skinHue,
      os.characters.get(2)!.skinHue,
      'same type → distinguishable hues',
    );
  });

  test('closing the agent hands the resident back: it stays, frees the seat, roams', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    os.addResident('codex', 'Rex');
    settle(os);
    const homeId = os.getResidents()[0].characterId;
    os.addAgent(5, undefined, undefined, undefined, true, 'app', undefined, {
      providerId: 'codex',
      agentLabel: 'Codex · app',
    });
    const body = os.characters.get(5)!;
    for (let i = 0; i < 400 && body.state !== CharacterState.TYPE; i++) os.update(0.05);
    const seatId = body.seatId!;
    body.bubbleType = 'permission';
    body.contextTokens = 1234;
    os.selectedAgentId = 5;

    os.removeAgent(5);

    assert.equal(os.characters.has(5), false);
    assert.equal(os.characters.get(homeId), body, 'back under its own id');
    assert.equal(body.id, homeId);
    assert.equal(body.matrixEffect, null, 'not despawning');
    assert.equal(body.seatId, null);
    assert.equal(os.seats.get(seatId)!.assigned, false, 'seat freed for others');
    assert.equal(body.isActive, false);
    assert.equal(body.bubbleType, null);
    assert.equal(body.agentLabel, undefined);
    assert.equal(body.directoryName, undefined);
    assert.equal(body.contextTokens, 0);
    assert.equal(body.residentName, 'Rex', 'still the resident');
    assert.equal(os.selectedAgentId, null);
    assert.equal(os.getResidents()[0].boundAgentId, null);

    // Stands up after a short delay and roams (never sits again while idle).
    let stood = false;
    for (let i = 0; i < 600; i++) {
      os.update(0.05);
      if (body.state !== CharacterState.TYPE) stood = true;
      if (stood) assert.notEqual(body.state, CharacterState.TYPE);
    }
    assert.ok(stood);

    // A new agent of the type binds it again.
    os.addAgent(6, undefined, undefined, undefined, true, undefined, undefined, {
      providerId: 'codex',
    });
    assert.equal(os.characters.get(6), body);
  });

  test('closing a plain agent still despawns it', () => {
    const os = new OfficeState(layoutWith(chairs(1)));
    os.addAgent(1, 0, 0, undefined, true);
    os.removeAgent(1);
    assert.equal(os.characters.get(1)!.matrixEffect, 'despawn');
  });

  test('removeAgent on a free resident id is a no-op (residents are removed via removeResident)', () => {
    const os = new OfficeState(layoutWith());
    os.addResident('kimi');
    const id = os.getResidents()[0].characterId;
    os.removeAgent(id);
    assert.equal(os.characters.get(id)!.matrixEffect, 'spawn');
  });

  test('sub-agents of a bound resident inherit its agent type and hue, spawning beside it', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    os.addResident('codex');
    os.addResident('codex');
    settle(os);
    os.addAgent(1, undefined, undefined, undefined, true, undefined, undefined, {
      providerId: 'codex',
    });
    os.addAgent(2, undefined, undefined, undefined, true, undefined, undefined, {
      providerId: 'codex',
    });
    const parent = os.characters.get(2)!;
    const subId = os.addSubagent(2, 'toolu_1');
    const sub = os.characters.get(subId)!;
    assert.equal(sub.providerId, 'codex');
    assert.equal(sub.skinHue, parent.skinHue);
    const d = Math.abs(sub.tileCol - parent.tileCol) + Math.abs(sub.tileRow - parent.tileRow);
    assert.ok(d <= 2, `sub spawned ${d} tiles from its parent`);
  });

  test('free residents are never handed a seat by a layout rebuild', () => {
    const os = new OfficeState(layoutWith(chairs(3)));
    os.addResident('codex');
    os.rebuildFromLayout(layoutWith(chairs(3)));
    const id = os.getResidents()[0].characterId;
    assert.equal(os.characters.get(id)!.seatId, null);
    assert.ok([...os.seats.values()].every((s) => !s.assigned));
  });

  test('removing a resident: a free one dematerializes, a bound one stays as the agent', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    const r1 = os.addResident('codex')!;
    const r2 = os.addResident('kimi')!;
    settle(os);
    os.addAgent(9, undefined, undefined, undefined, true, undefined, undefined, {
      providerId: 'kimi',
    });
    const freeId = os.getResidents().find((r) => r.id === r1)!.characterId;
    os.selectedAgentId = freeId;

    os.removeResident(r1);
    assert.equal(os.characters.get(freeId)!.matrixEffect, 'despawn');
    assert.equal(os.selectedAgentId, null);
    settle(os);
    assert.equal(os.characters.has(freeId), false);

    os.removeResident(r2);
    const agent = os.characters.get(9)!;
    assert.equal(agent.matrixEffect, null);
    assert.equal(agent.residentId, undefined);
    os.removeAgent(9);
    assert.equal(agent.matrixEffect, 'despawn', 'no longer a resident → despawns on close');
    assert.deepEqual(os.getResidents(), []);
  });
});

// ── Layout round-trip ──────────────────────────────────────────

describe('residents: layout serialization', () => {
  test('the roster is mirrored into layout.residents', () => {
    const os = new OfficeState(layoutWith());
    const id = os.addResident('codex', 'Rex')!;
    os.addResident('gemini');
    assert.deepEqual(os.getLayout().residents, [
      { id, providerId: 'codex', name: 'Rex' },
      { id: os.getResidents()[1].id, providerId: 'gemini' },
    ]);
    // Survives JSON (what saveLayout sends).
    const copy = JSON.parse(JSON.stringify(os.getLayout())) as OfficeLayout;
    const os2 = new OfficeState(copy);
    assert.deepEqual(
      os2.getResidents().map((r) => [r.id, r.providerId, r.name ?? null]),
      [
        [id, 'codex', 'Rex'],
        [os.getResidents()[1].id, 'gemini', null],
      ],
    );
    const restored = os2.characters.get(os2.getResidents()[0].characterId)!;
    assert.equal(restored.matrixEffect, null, 'restored residents appear without the effect');
  });

  test('an office that never used residents keeps a layout without the field', () => {
    const layout = layoutWith();
    const os = new OfficeState(layout);
    os.rebuildFromLayout(layoutWith());
    assert.equal('residents' in os.getLayout(), false);
  });

  test('editor rebuilds (edit, undo, reset, import) keep the live roster', () => {
    const os = new OfficeState(layoutWith());
    const before = os.getLayout(); // e.g. an undo snapshot taken before the add
    const id = os.addResident('codex')!;
    const charId = os.getResidents()[0].characterId;
    const ch = os.characters.get(charId)!;

    // An edit / undo restores a layout object that has no (or a stale) roster.
    const edited: OfficeLayout = { ...before, residents: [], tiles: [...before.tiles] };
    os.rebuildFromLayout(edited);
    assert.equal(os.getResidents().length, 1, 'undo never removes a resident');
    assert.equal(os.characters.get(charId), ch, 'same character, not respawned');
    assert.deepEqual(os.getLayout().residents, [{ id, providerId: 'codex' }]);
    assert.equal(os.getLayout(), edited, 'roster written into the new layout object');
  });

  test('a host-loaded layout is adopted: adds, renames and removes residents', () => {
    const os = new OfficeState(layoutWith());
    const keep = os.addResident('codex', 'Old')!;
    const drop = os.addResident('kimi')!;
    settle(os);
    const keepChar = os.getResidents()[0].characterId;
    const keepCh = os.characters.get(keepChar)!;
    const dropChar = os.getResidents()[1].characterId;

    const loaded: OfficeLayout = {
      ...layoutWith(),
      residents: [
        { id: 'new-one', providerId: 'qwen' },
        { id: keep, providerId: 'codex', name: 'New' },
      ],
    };
    os.rebuildFromLayout(loaded, undefined, { adoptResidents: true });

    assert.deepEqual(
      os.getResidents().map((r) => r.id),
      ['new-one', keep],
      'roster follows the loaded order',
    );
    assert.equal(os.characters.get(keepChar), keepCh, 'kept residents keep their character');
    assert.equal(keepCh.residentName, 'New');
    assert.equal(os.characters.get(dropChar)!.matrixEffect, 'despawn');
    assert.ok(!os.getResidents().some((r) => r.id === drop));
  });

  test('a junk residents field in a stored layout is tolerated', () => {
    const layout = { ...layoutWith(), residents: 'oops' } as unknown as OfficeLayout;
    const os = new OfficeState(layout);
    assert.deepEqual(os.getResidents(), []);
    assert.deepEqual(os.getLayout().residents, []);
  });
});

// ── Layout rebuilds vs roaming ─────────────────────────────────

describe('layout rebuilds leave roaming characters where they are', () => {
  test('a roaming agent keeps its seat but is not teleported onto it; a seated one stays put', () => {
    const os = new OfficeState(layoutWith(chairs(2)));
    os.addAgent(1, 0, 0, undefined, true);
    os.addAgent(2, 1, 0, undefined, true);
    const roamer = os.characters.get(1)!;
    const sitter = os.characters.get(2)!;
    for (let i = 0; i < 100; i++) os.update(0.05); // both reach their seats
    os.setAgentActive(1, false);
    for (let i = 0; i < 200 && roamer.state === CharacterState.TYPE; i++) os.update(0.05);
    assert.notEqual(roamer.state, CharacterState.TYPE);
    // Park it somewhere off its seat.
    roamer.state = CharacterState.IDLE;
    roamer.tileCol = 4;
    roamer.tileRow = 2;
    roamer.x = 4 * 16 + 8;
    roamer.y = 2 * 16 + 8;
    const roamerSeat = roamer.seatId;
    const sitterSeat = os.seats.get(sitter.seatId!)!;

    os.rebuildFromLayout(layoutWith(chairs(2)));

    assert.equal(roamer.seatId, roamerSeat, 'keeps its seat');
    assert.deepEqual([roamer.tileCol, roamer.tileRow], [4, 2], 'not teleported');
    assert.equal(sitter.state, CharacterState.TYPE);
    assert.deepEqual([sitter.tileCol, sitter.tileRow], [sitterSeat.seatCol, sitterSeat.seatRow]);
  });

  test('a roaming character left inside new furniture is moved to a walkable tile', () => {
    const os = new OfficeState(layoutWith());
    os.addResident('codex');
    const ch = os.characters.get(os.getResidents()[0].characterId)!;
    ch.tileCol = 3;
    ch.tileRow = 3;
    os.rebuildFromLayout(layoutWith([{ uid: 'c', type: 'TEST_CHAIR', col: 3, row: 3 }]));
    assert.notDeepEqual([ch.tileCol, ch.tileRow], [3, 3]);
  });
});
