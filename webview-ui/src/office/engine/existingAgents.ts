// webview-ui/src/office/engine/existingAgents.ts
//
// Pure reconciliation for the `existingAgents` restore message. Extracted from
// useExtensionMessages so it can be unit-tested without React (mirrors
// officeCanvasCursor.ts). The deliberate e2e-over-unit policy forbids unit
// tests against the React message handler itself.
//
// The webview must handle BOTH orders in which the two restore messages arrive:
//   - existingAgents before layoutLoaded → buffer, flush on the next layoutLoaded
//   - layoutLoaded before existingAgents → layout + seats already built, add now
// Depending on layoutLoaded always arriving last stranded restored agents on any
// surface that sends layout first (e.g. the VS Code no-assets path), issue #334.

/** Per-agent seat metadata carried by the existingAgents message. */
export interface ExistingAgentMeta {
  palette?: number;
  hueShift?: number;
  seatId?: string;
  /** Agent type; absent = Claude. */
  providerId?: string;
  /** Display label for non-Claude agents. */
  agentLabel?: string;
}

/** Agent-type details addAgent takes beyond seat and palette. */
export interface AddAgentOptions {
  providerId?: string;
  agentLabel?: string;
}

/** An agent buffered until the layout (and its seats) has been built. */
export interface PendingAgent {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  directoryName?: string;
  isHeadless?: boolean;
  providerId?: string;
  agentLabel?: string;
}

/** The addAgent options a buffered/restored agent carries (keys only when set). */
export function addAgentOptionsOf(p: {
  providerId?: string;
  agentLabel?: string;
}): AddAgentOptions {
  const opts: AddAgentOptions = {};
  if (p.providerId !== undefined) opts.providerId = p.providerId;
  if (p.agentLabel !== undefined) opts.agentLabel = p.agentLabel;
  return opts;
}

/** Minimal structural view of OfficeState this reconciler needs. */
export interface ExistingAgentsOffice {
  characters: { has: (id: number) => boolean };
  addAgent: (
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    directoryName?: string,
    nearAgentId?: number,
    opts?: AddAgentOptions,
  ) => void;
  setHeadless: (id: number, headless: boolean) => void;
}

/**
 * Reconcile an `existingAgents` payload into the office. When the layout is
 * already built, agents are added immediately (skipping the matrix spawn effect,
 * as restored agents do) unless they already exist; otherwise they are pushed
 * onto `pending` to be flushed by the next `layoutLoaded`. Returns true if any
 * agent was added directly, so the caller can persist seat assignments.
 */
export function reconcileExistingAgents(
  os: ExistingAgentsOffice,
  incoming: number[],
  meta: Record<number, ExistingAgentMeta>,
  directoryNames: Record<number, string>,
  layoutReady: boolean,
  pending: PendingAgent[],
  headlessAgents: Record<number, boolean> = {},
): boolean {
  let addedDirectly = false;
  for (const id of incoming) {
    const m = meta[id];
    const p: PendingAgent = {
      id,
      palette: m?.palette,
      hueShift: m?.hueShift,
      seatId: m?.seatId,
      directoryName: directoryNames[id],
      isHeadless: headlessAgents[id] === true,
    };
    if (m?.providerId !== undefined) p.providerId = m.providerId;
    if (m?.agentLabel !== undefined) p.agentLabel = m.agentLabel;
    if (layoutReady) {
      if (!os.characters.has(p.id)) {
        os.addAgent(
          p.id,
          p.palette,
          p.hueShift,
          p.seatId,
          true,
          p.directoryName,
          undefined,
          addAgentOptionsOf(p),
        );
        if (p.isHeadless) os.setHeadless(p.id, true);
        addedDirectly = true;
      }
    } else {
      pending.push(p);
    }
  }
  return addedDirectly;
}
