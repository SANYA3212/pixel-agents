/**
 * Binary chatter: roaming characters say a few bits ("0101 1101") now and
 * then; two idle characters standing close face each other and alternate
 * bubbles. Status bubbles (permission / waiting) always win, and a character
 * that gets work stops talking.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { describe, test } from 'vitest';

import {
  CHATTER_BITS_MAX,
  CHATTER_BITS_MIN,
  CHATTER_BUBBLE_MAX_SEC,
  CHATTER_BUBBLE_MIN_SEC,
} from '../src/constants.js';
import { createCharacter } from '../src/office/engine/characters.js';
import {
  canChatter,
  ChatterSystem,
  chatterVisible,
  directionToward,
  makeChatBubble,
  randomBits,
} from '../src/office/engine/chatter.js';
import type { Character } from '../src/office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../src/office/types.js';

function idleAt(id: number, col: number, row: number): Character {
  const ch = createCharacter(id, 0, null, null);
  ch.state = CharacterState.IDLE;
  ch.isActive = false;
  ch.tileCol = col;
  ch.tileRow = row;
  ch.x = col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = row * TILE_SIZE + TILE_SIZE / 2;
  ch.wanderTimer = 5;
  return ch;
}

/** A simple seeded PRNG (mulberry32) so the tests are exact but varied. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('bit strings and bubbles', () => {
  test('randomBits: 4–8 zeros/ones grouped in nibbles', () => {
    const rng = prng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const s = randomBits(rng);
      assert.match(s, /^[01]{4}( [01]{1,4})?$/, s);
      const bits = s.replace(' ', '').length;
      assert.ok(bits >= CHATTER_BITS_MIN && bits <= CHATTER_BITS_MAX);
      seen.add(bits);
    }
    assert.equal(seen.size, CHATTER_BITS_MAX - CHATTER_BITS_MIN + 1, 'every length occurs');
  });

  test('a bubble lives 1.5–2.5 s', () => {
    for (const r of [0, 0.5, 0.999]) {
      const b = makeChatBubble(() => r);
      assert.ok(b.duration >= CHATTER_BUBBLE_MIN_SEC && b.duration <= CHATTER_BUBBLE_MAX_SEC);
      assert.equal(b.timer, b.duration);
    }
  });

  test('status bubbles win: no chatter with one up, none drawn either', () => {
    const ch = idleAt(1, 1, 1);
    assert.equal(canChatter(ch), true);
    ch.bubbleType = 'waiting';
    assert.equal(canChatter(ch), false);
    ch.chat = makeChatBubble();
    assert.equal(chatterVisible(ch), false);
    ch.bubbleType = null;
    assert.equal(chatterVisible(ch), true);
    ch.isActive = true;
    assert.equal(chatterVisible(ch), false, 'working characters do not chatter');
  });

  test('directionToward picks the dominant axis', () => {
    assert.equal(directionToward({ x: 0, y: 0 }, { x: 10, y: 2 }), Direction.RIGHT);
    assert.equal(directionToward({ x: 0, y: 0 }, { x: -10, y: 2 }), Direction.LEFT);
    assert.equal(directionToward({ x: 0, y: 0 }, { x: 1, y: 9 }), Direction.DOWN);
    assert.equal(directionToward({ x: 0, y: 0 }, { x: 1, y: -9 }), Direction.UP);
  });
});

describe('ChatterSystem', () => {
  test('two idle characters close together converse: face each other, alternate bubbles', () => {
    const sys = new ChatterSystem(prng(7));
    const a = idleAt(1, 2, 2);
    const b = idleAt(2, 3, 2);
    a.dir = Direction.DOWN;
    b.dir = Direction.DOWN;
    const speakers: number[] = [];
    let prev: { a: boolean; b: boolean } = { a: false, b: false };
    let started = false;
    for (let i = 0; i < 400; i++) {
      sys.update([a, b], 0.05);
      if (sys.inConversation(1)) started = true;
      else if (started) break; // only the first conversation
      const now = { a: !!a.chat, b: !!b.chat };
      if (now.a && !prev.a) speakers.push(1);
      if (now.b && !prev.b) speakers.push(2);
      assert.ok(!(now.a && now.b), 'never both at once');
      if (sys.inConversation(1)) {
        assert.equal(a.dir, Direction.RIGHT, 'a faces b');
        assert.equal(b.dir, Direction.LEFT, 'b faces a');
        assert.ok(a.wanderTimer >= 1 && b.wanderTimer >= 1, 'both hold still while talking');
      }
      prev = now;
    }
    assert.ok(speakers.length >= 2, `expected a conversation, got ${speakers.join(',')}`);
    for (let i = 1; i < speakers.length; i++) {
      assert.notEqual(speakers[i], speakers[i - 1], 'turns alternate');
    }
  });

  test('characters far apart never start a conversation', () => {
    const sys = new ChatterSystem(prng(3));
    const a = idleAt(1, 0, 0);
    const b = idleAt(2, 8, 8);
    for (let i = 0; i < 2000; i++) {
      sys.update([a, b], 0.05);
      assert.equal(sys.inConversation(1), false);
    }
  });

  test('a lone roamer mutters now and then, with a cooldown in between', () => {
    const sys = new ChatterSystem(prng(11));
    const a = idleAt(1, 0, 0);
    let bubbles = 0;
    let had = false;
    // Five simulated minutes.
    for (let i = 0; i < 6000; i++) {
      sys.update([a], 0.05);
      if (a.chat && !had) bubbles++;
      had = !!a.chat;
    }
    assert.ok(bubbles >= 2, `expected occasional solo chatter, got ${bubbles}`);
    assert.ok(bubbles < 60, `chatter should be occasional, got ${bubbles}`);
  });

  test('getting work ends the conversation and silences the speaker at once', () => {
    const sys = new ChatterSystem(prng(7));
    const a = idleAt(1, 2, 2);
    const b = idleAt(2, 2, 3);
    for (let i = 0; i < 400 && !sys.inConversation(1); i++) sys.update([a, b], 0.05);
    assert.equal(sys.inConversation(1), true);
    assert.equal(sys.partnerOf(1), 2);
    a.isActive = true;
    sys.update([a, b], 0.05);
    assert.equal(a.chat, null);
    assert.equal(sys.inConversation(1), false);
    assert.equal(sys.inConversation(2), false);
    assert.ok((b.chatCooldown ?? 0) > 0, 'the partner rests from talking');
  });

  test('a permission bubble on one partner ends the talk', () => {
    const sys = new ChatterSystem(prng(7));
    const a = idleAt(1, 2, 2);
    const b = idleAt(2, 2, 3);
    for (let i = 0; i < 400 && !sys.inConversation(1); i++) sys.update([a, b], 0.05);
    b.bubbleType = 'permission';
    sys.update([a, b], 0.05);
    assert.equal(sys.inConversation(2), false);
  });

  test('forget drops a character from its conversation (e.g. a resident got bound)', () => {
    const sys = new ChatterSystem(prng(7));
    const a = idleAt(1, 2, 2);
    const b = idleAt(2, 2, 3);
    for (let i = 0; i < 400 && !sys.inConversation(1); i++) sys.update([a, b], 0.05);
    sys.forget(1);
    assert.equal(sys.inConversation(2), false);
  });

  test('seated, walking-to-work or materializing characters never chatter', () => {
    const sys = new ChatterSystem(() => 0); // every roll succeeds
    const seated = idleAt(1, 0, 0);
    seated.state = CharacterState.TYPE;
    const spawning = idleAt(2, 5, 5);
    spawning.matrixEffect = 'spawn';
    const working = idleAt(3, 9, 9);
    working.isActive = true;
    working.state = CharacterState.WALK;
    working.path = [{ col: 9, row: 8 }];
    for (let i = 0; i < 100; i++) sys.update([seated, spawning, working], 0.1);
    assert.equal(seated.chat ?? null, null);
    assert.equal(spawning.chat ?? null, null);
    assert.equal(working.chat ?? null, null);
  });
});
