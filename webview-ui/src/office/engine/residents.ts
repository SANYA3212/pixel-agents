// webview-ui/src/office/engine/residents.ts
//
// Pure rules for Residents — characters a user adds in the browser (like pets)
// that roam the office and become the body of a matching agent while it runs.
// DOM-free so the Node runner can test them; OfficeState owns the live state.

import {
  DEFAULT_PROVIDER_ID,
  MAX_RESIDENT_ID_LENGTH,
  MAX_RESIDENT_NAME_LENGTH,
  MAX_RESIDENTS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  SKIN_HUE_RANDOM_MAX,
  SKIN_HUE_RANDOM_MIN,
  SKIN_HUE_STEPS,
} from '../../constants.js';
import type { PlacedResident } from '../types.js';

/** Provider ids are short slugs; anything else in a stored layout is junk. */
const PROVIDER_ID_PATTERN = /^[a-z0-9_-]{1,32}$/i;

/** An agent type as the office uses it: a missing/garbled id is Claude. Unknown
 *  but well-formed ids pass through (a newer server may know more types). */
export function normalizeProviderId(providerId: unknown): string {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    return DEFAULT_PROVIDER_ID;
  }
  return providerId.toLowerCase();
}

/** Human label of an agent type ("Codex"), falling back to the raw id. */
export function providerLabel(providerId: string | undefined): string {
  const id = providerId ?? DEFAULT_PROVIDER_ID;
  return PROVIDER_LABELS[id] ?? id;
}

/** Trim a picker name to something safe to store and show. Empty → undefined. */
export function sanitizeResidentName(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  // Strip control characters (a pasted newline would break the label panel).
  const cleaned = Array.from(name)
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .trim()
    .slice(0, MAX_RESIDENT_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Validate the `residents` field of a stored layout: drops malformed entries
 * and duplicate ids, normalizes provider ids, caps the roster. Never throws.
 */
export function sanitizeResidents(raw: unknown): PlacedResident[] {
  if (!Array.isArray(raw)) return [];
  const out: PlacedResident[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= MAX_RESIDENTS) break;
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length === 0 || r.id.length > MAX_RESIDENT_ID_LENGTH) {
      continue;
    }
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const resident: PlacedResident = { id: r.id, providerId: normalizeProviderId(r.providerId) };
    const name = sanitizeResidentName(r.name);
    if (name !== undefined) resident.name = name;
    out.push(resident);
  }
  return out;
}

/** Collision-safe id for a new resident. `crypto.randomUUID` only exists on
 *  secure origins; a phone on the LAN over plain http has to fall back. */
export function newResidentId(rng: () => number = Math.random): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  let s = 'res-';
  for (let i = 0; i < 16; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

/**
 * Hue shift for a new character of an agent type, given the skin hues the
 * other visible characters of that type already use: the first free step of
 * SKIN_HUE_STEPS (so the first one keeps the skin as drawn), then random.
 */
export function pickSkinHue(usedHues: Iterable<number>, rng: () => number = Math.random): number {
  const used = new Set(usedHues);
  for (const hue of SKIN_HUE_STEPS) {
    if (!used.has(hue)) return hue;
  }
  return Math.round(SKIN_HUE_RANDOM_MIN + rng() * (SKIN_HUE_RANDOM_MAX - SKIN_HUE_RANDOM_MIN));
}

/** Palette a resident falls back to when its type has no skin: stable per
 *  type so the picker preview matches what spawns. */
export function fallbackPaletteFor(providerId: string, paletteCount: number): number {
  const idx = (PROVIDER_IDS as readonly string[]).indexOf(providerId);
  const n = Math.max(1, paletteCount);
  if (idx >= 0) return idx % n;
  let h = 0;
  for (const ch of providerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

/** A resident as the binding rules see it. */
export interface ResidentSlot {
  id: string;
  providerId: string;
  /** Agent currently using this resident as its body, or null when free. */
  boundAgentId: number | null;
}

/**
 * The resident a new agent of `providerId` should take over: the first free
 * one of that type in roster order, or null (the agent then gets a character
 * of its own, as before Residents existed).
 */
export function chooseResidentForAgent(
  residents: readonly ResidentSlot[],
  providerId: string | undefined,
): ResidentSlot | null {
  const want = normalizeProviderId(providerId);
  for (const r of residents) {
    if (r.boundAgentId === null && r.providerId === want) return r;
  }
  return null;
}

/** What a character is called on its card / tooltip: the agent's own label,
 *  prefixed by the resident's name when a resident hosts it. */
export function characterDisplayLabel(ch: {
  agentLabel?: string;
  residentName?: string;
}): string | undefined {
  if (ch.residentName && ch.agentLabel) return `${ch.residentName} · ${ch.agentLabel}`;
  return ch.agentLabel ?? ch.residentName;
}

/** Name shown for a resident that has no agent: its own name, else its type. */
export function residentDisplayName(r: { name?: string; providerId: string }): string {
  return r.name ?? `${providerLabel(r.providerId)} resident`;
}
