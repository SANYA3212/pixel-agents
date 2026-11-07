// webview-ui/src/office/engine/chatter.ts
//
// Binary chatter: roaming characters now and then "say" a few bits
// ("0101 1101") in a small speech bubble. Two idle characters standing close
// face each other and trade bubbles like a conversation. Status bubbles
// (permission / waiting) always win: a character showing one neither starts
// chatter nor has its chatter drawn (ToolOverlay checks `chatterVisible`).
//
// DOM-free; the bubble lives on the character (`ch.chat`) so the overlay can
// draw it, the conversations live here. Random sources are injected.

import {
  CHATTER_BITS_MAX,
  CHATTER_BITS_MIN,
  CHATTER_BUBBLE_MAX_SEC,
  CHATTER_BUBBLE_MIN_SEC,
  CHATTER_CONVERSATION_RANGE_TILES,
  CHATTER_CONVERSATION_RATE_PER_SEC,
  CHATTER_CONVERSATION_TURNS_MAX,
  CHATTER_CONVERSATION_TURNS_MIN,
  CHATTER_COOLDOWN_MAX_SEC,
  CHATTER_COOLDOWN_MIN_SEC,
  CHATTER_GROUP_SIZE,
  CHATTER_SOLO_RATE_PER_SEC,
  CHATTER_TURN_GAP_SEC,
  ROAM_PAUSE_MIN_SEC,
} from '../../constants.js';
import type { ChatBubble, Direction as DirectionVal } from '../types.js';
import { CharacterState, Direction } from '../types.js';
import type { RoamActor } from './roaming.js';
import { isIdleStanding, isRoaming } from './roaming.js';

/** The parts of a character chatter reads and writes. */
export interface ChatterActor extends RoamActor {
  x: number;
  y: number;
  dir: DirectionVal;
  bubbleType: 'permission' | 'waiting' | null;
  wanderTimer: number;
  isGreeter?: boolean;
  chat?: ChatBubble | null;
  chatCooldown?: number;
}

interface Conversation {
  a: number;
  b: number;
  /** Who says the next bubble. */
  next: number;
  /** Bubbles left to say (both speakers together). */
  turnsLeft: number;
  /** Silence left before the next bubble once the current one ends. */
  gap: number;
}

function range(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min);
}

function randomInt(min: number, max: number, rng: () => number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** "0101 1101": CHATTER_BITS_MIN..MAX random bits, grouped in nibbles. */
export function randomBits(rng: () => number = Math.random): string {
  const n = randomInt(CHATTER_BITS_MIN, CHATTER_BITS_MAX, rng);
  let s = '';
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % CHATTER_GROUP_SIZE === 0) s += ' ';
    s += rng() < 0.5 ? '0' : '1';
  }
  return s;
}

/** A fresh chatter bubble. */
export function makeChatBubble(rng: () => number = Math.random): ChatBubble {
  const duration = range(CHATTER_BUBBLE_MIN_SEC, CHATTER_BUBBLE_MAX_SEC, rng);
  return { text: randomBits(rng), timer: duration, duration };
}

/** May this character chatter right now? Roaming, no status bubble up. */
export function canChatter(ch: ChatterActor): boolean {
  return !ch.isGreeter && isRoaming(ch) && ch.bubbleType === null;
}

/** Should the overlay draw this character's chatter bubble? Status bubbles win. */
export function chatterVisible(ch: {
  chat?: ChatBubble | null;
  bubbleType: 'permission' | 'waiting' | null;
  matrixEffect: 'spawn' | 'despawn' | null;
  isActive: boolean;
}): boolean {
  return !!ch.chat && ch.bubbleType === null && ch.matrixEffect === null && !ch.isActive;
}

/** Direction from `a` toward `b` (the dominant axis wins). */
export function directionToward(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? Direction.RIGHT : Direction.LEFT;
  return dy >= 0 ? Direction.DOWN : Direction.UP;
}

function tileDistance(a: ChatterActor, b: ChatterActor): number {
  return Math.abs(a.tileCol - b.tileCol) + Math.abs(a.tileRow - b.tileRow);
}

/** Probability that a Poisson event with `ratePerSec` happens within `dt`. */
function chanceIn(ratePerSec: number, dt: number): number {
  return 1 - Math.exp(-ratePerSec * dt);
}

export class ChatterSystem {
  private conversations: Conversation[] = [];
  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  /** Whether `id` is in a conversation right now. */
  inConversation(id: number): boolean {
    return this.conversations.some((c) => c.a === id || c.b === id);
  }

  /** Partner of `id` in its current conversation, or null. */
  partnerOf(id: number): number | null {
    const c = this.conversations.find((cv) => cv.a === id || cv.b === id);
    if (!c) return null;
    return c.a === id ? c.b : c.a;
  }

  /** Drop every conversation `id` takes part in (its character went away or
   *  changed identity, e.g. a Resident bound to an agent). */
  forget(id: number): void {
    this.conversations = this.conversations.filter((c) => c.a !== id && c.b !== id);
  }

  private say(ch: ChatterActor): void {
    ch.chat = makeChatBubble(this.rng);
  }

  private cooldown(): number {
    return range(CHATTER_COOLDOWN_MIN_SEC, CHATTER_COOLDOWN_MAX_SEC, this.rng);
  }

  /** Close a conversation: both partners rest from talking, then wander off soon. */
  private endConversation(conv: Conversation, byId: Map<number, ChatterActor>): void {
    for (const id of [conv.a, conv.b]) {
      const ch = byId.get(id);
      if (!ch) continue;
      ch.chatCooldown = this.cooldown();
      if (isIdleStanding(ch)) ch.wanderTimer = range(0.3, ROAM_PAUSE_MIN_SEC, this.rng);
    }
  }

  /** Advance bubbles, conversations and new chatter by `dt` seconds. */
  update(chars: readonly ChatterActor[], dt: number): void {
    const byId = new Map<number, ChatterActor>();
    for (const ch of chars) byId.set(ch.id, ch);

    // 1. Bubble timers and cooldowns. A character that got work (or a status
    //    bubble) stops talking at once.
    for (const ch of chars) {
      if (ch.chat) {
        ch.chat.timer -= dt;
        if (ch.chat.timer <= 0 || ch.isActive || ch.state === CharacterState.TYPE) ch.chat = null;
      }
      if (ch.chatCooldown && ch.chatCooldown > 0) {
        ch.chatCooldown = Math.max(0, ch.chatCooldown - dt);
      }
    }

    // 2. Running conversations.
    const kept: Conversation[] = [];
    for (const conv of this.conversations) {
      const a = byId.get(conv.a);
      const b = byId.get(conv.b);
      if (
        !a ||
        !b ||
        !canChatter(a) ||
        !canChatter(b) ||
        !isIdleStanding(a) ||
        !isIdleStanding(b)
      ) {
        // Someone left, got a task, or walked off — the talk is over.
        if (a || b) this.endConversation(conv, byId);
        continue;
      }
      // Keep both standing and facing each other while they talk.
      a.dir = directionToward(a, b);
      b.dir = directionToward(b, a);
      a.wanderTimer = Math.max(a.wanderTimer, 1);
      b.wanderTimer = Math.max(b.wanderTimer, 1);

      if (a.chat || b.chat) {
        kept.push(conv);
        continue; // someone is mid-sentence
      }
      if (conv.gap > 0) {
        conv.gap -= dt;
        kept.push(conv);
        continue;
      }
      if (conv.turnsLeft <= 0) {
        this.endConversation(conv, byId);
        continue;
      }
      const speaker = conv.next === a.id ? a : b;
      this.say(speaker);
      conv.next = speaker === a ? b.id : a.id;
      conv.turnsLeft--;
      conv.gap = CHATTER_TURN_GAP_SEC;
      kept.push(conv);
    }
    this.conversations = kept;

    // 3. New conversations between idle characters standing close together.
    const ready = chars.filter(
      (ch) =>
        canChatter(ch) &&
        isIdleStanding(ch) &&
        !ch.chat &&
        !(ch.chatCooldown && ch.chatCooldown > 0) &&
        !this.inConversation(ch.id),
    );
    const taken = new Set<number>();
    const pairChance = chanceIn(CHATTER_CONVERSATION_RATE_PER_SEC, dt);
    for (let i = 0; i < ready.length; i++) {
      const a = ready[i];
      if (taken.has(a.id)) continue;
      for (let j = i + 1; j < ready.length; j++) {
        const b = ready[j];
        if (taken.has(b.id)) continue;
        if (tileDistance(a, b) > CHATTER_CONVERSATION_RANGE_TILES) continue;
        if (this.rng() >= pairChance) continue;
        taken.add(a.id);
        taken.add(b.id);
        const first = this.rng() < 0.5 ? a : b;
        const other = first === a ? b : a;
        a.dir = directionToward(a, b);
        b.dir = directionToward(b, a);
        // Hold both in place from the first bubble on (the FSM runs first
        // next frame and would otherwise walk one of them off).
        a.wanderTimer = Math.max(a.wanderTimer, 1);
        b.wanderTimer = Math.max(b.wanderTimer, 1);
        this.say(first);
        this.conversations.push({
          a: a.id,
          b: b.id,
          next: other.id,
          turnsLeft:
            randomInt(CHATTER_CONVERSATION_TURNS_MIN, CHATTER_CONVERSATION_TURNS_MAX, this.rng) - 1,
          gap: CHATTER_TURN_GAP_SEC,
        });
        break;
      }
    }

    // 4. Solo chatter: a lone roamer mutters a few bits now and then.
    const soloChance = chanceIn(CHATTER_SOLO_RATE_PER_SEC, dt);
    for (const ch of chars) {
      if (taken.has(ch.id) || !canChatter(ch) || ch.chat) continue;
      if (ch.chatCooldown && ch.chatCooldown > 0) continue;
      if (this.inConversation(ch.id)) continue;
      if (this.rng() < soloChance) {
        this.say(ch);
        ch.chatCooldown = this.cooldown();
      }
    }
  }
}
