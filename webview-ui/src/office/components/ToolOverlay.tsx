import { Fragment, useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import {
  BUBBLE_FADE_DURATION_SEC,
  BUBBLE_SITTING_OFFSET_PX,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  CHATTER_BUBBLE_BG,
  CHATTER_BUBBLE_BORDER,
  CHATTER_BUBBLE_RISE_WORLD,
  CHATTER_BUBBLE_TEXT,
  CHATTER_BUBBLE_Z_INDEX,
  CHATTER_FADE_SEC,
  CHATTER_LABEL_CLEARANCE_PX,
  CONTEXT_CRITICAL_THRESHOLD,
  CONTEXT_DANGER_THRESHOLD,
  CONTEXT_GAUGE_BG,
  CONTEXT_GAUGE_COLOR_CRITICAL,
  CONTEXT_GAUGE_COLOR_DANGER,
  CONTEXT_GAUGE_COLOR_OK,
  CONTEXT_GAUGE_COLOR_WARN,
  CONTEXT_GAUGE_HEIGHT_PX,
  CONTEXT_GAUGE_WIDTH_PX,
  CONTEXT_WARN_THRESHOLD,
  DEFAULT_PROVIDER_ID,
  OVERLAY_BUBBLE_Z_INDEX,
  OVERLAY_LABEL_SELECTED_Z_INDEX,
  OVERLAY_LABEL_Z_INDEX,
  RESIDENT_NAME_COLOR,
  TEAM_LEAD_COLOR,
  TEAM_ROLE_COLOR,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js';
import { chatterVisible } from '../engine/chatter.js';
import type { OfficeState } from '../engine/officeState.js';
import { residentDisplayName } from '../engine/residents.js';
import { overlayProjection } from '../projection.js';
import { getCachedSprite } from '../sprites/spriteCache.js';
import { BUBBLE_PERMISSION_SPRITE, BUBBLE_WAITING_SPRITE } from '../sprites/spriteData.js';
import type { Character, ToolActivity } from '../types.js';
import { CharacterState } from '../types.js';

// Both turn-end states show the green checkmark bubble. A finished turn (Stop)
// shows ONLY the checkmark (the label falls through to its normal idle text);
// going idle waiting on the user (Notification(idle_prompt)) additionally
// surfaces this label. Driven by Character.waitingAwaitingInput.
const WAITING_INPUT_ACTIVITY_TEXT = 'Waiting for input';

interface ToolOverlayProps {
  officeState: OfficeState;
  agents: number[];
  agentTools: Record<number, ToolActivity[]>;
  subagentTools: Record<number, Record<string, ToolActivity[]>>;
  subagentCharacters: SubagentCharacter[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onCloseAgent: (id: number) => void;
  /** Remove a Resident (the x on a selected resident that hosts no agent). */
  onRemoveResident?: (residentId: string) => void;
  alwaysShowOverlay: boolean;
}

/** Derive a short human-readable activity string from tools/status */
function getActivityText(
  agentId: number,
  agentTools: Record<number, ToolActivity[]>,
  isActive: boolean,
  bubbleType: 'permission' | 'waiting' | null,
  waitingAwaitingInput: boolean,
): string {
  if (bubbleType === 'permission') return 'Needs approval';
  // Only the idle case ("Waiting for input") gets a dedicated label. A finished
  // turn (Stop, waitingAwaitingInput=false) falls through so the checkmark alone
  // signals "done", same as the original behavior.
  if (bubbleType === 'waiting' && waitingAwaitingInput) return WAITING_INPUT_ACTIVITY_TEXT;

  const tools = agentTools[agentId];
  if (tools && tools.length > 0) {
    // Find the latest non-done tool
    const activeTool = [...tools].reverse().find((t) => !t.done);
    if (activeTool) {
      if (activeTool.permissionWait) return 'Needs approval';
      return activeTool.status;
    }
    // All tools done but agent still active (mid-turn) — keep showing last tool status
    if (isActive) {
      const lastTool = tools[tools.length - 1];
      if (lastTool) return lastTool.status;
    }
  }

  return 'Idle';
}

function getFuelColor(ratio: number): string {
  if (ratio >= CONTEXT_CRITICAL_THRESHOLD) return CONTEXT_GAUGE_COLOR_CRITICAL;
  if (ratio >= CONTEXT_DANGER_THRESHOLD) return CONTEXT_GAUGE_COLOR_DANGER;
  if (ratio >= CONTEXT_WARN_THRESHOLD) return CONTEXT_GAUGE_COLOR_WARN;
  return CONTEXT_GAUGE_COLOR_OK;
}

/** A speech-bubble sprite blitted into a DOM canvas. Bubbles live in the DOM
 *  (not the office canvas) so they can stack ABOVE the status label panels —
 *  canvas content can never out-paint the DOM overlay. */
function OverlayBubble({ cached, dpr }: { cached: HTMLCanvasElement; dpr: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = cached.width;
    canvas.height = cached.height;
    canvas.getContext('2d')?.drawImage(cached, 0, 0);
  }, [cached]);
  return (
    <canvas
      ref={canvasRef}
      className="block"
      style={{ width: cached.width / dpr, height: cached.height / dpr }}
    />
  );
}

/** Binary chatter bubble ("0101 1101") over a roaming character. Drawn under
 *  the status labels and the waiting/permission bubbles, which always win. */
function ChatterBubble({
  ch,
  left,
  bottom,
  fontSize,
}: {
  ch: Character;
  left: number;
  bottom: number;
  fontSize: number;
}) {
  const chat = ch.chat;
  if (!chat) return null;
  const alpha = chat.timer < CHATTER_FADE_SEC ? Math.max(0, chat.timer / CHATTER_FADE_SEC) : 1;
  const tail = Math.max(2, Math.round(fontSize / 4));
  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-full pointer-events-none flex flex-col items-center"
      style={{ left, top: bottom, opacity: alpha, zIndex: CHATTER_BUBBLE_Z_INDEX }}
      data-testid="chatter-bubble"
      data-agent-id={ch.id}
    >
      <div
        className="whitespace-nowrap leading-none shadow-pixel"
        style={{
          fontSize,
          padding: `${tail}px ${tail * 2}px`,
          background: CHATTER_BUBBLE_BG,
          color: CHATTER_BUBBLE_TEXT,
          border: `2px solid ${CHATTER_BUBBLE_BORDER}`,
        }}
      >
        {chat.text}
      </div>
      {/* Tail: two stacked squares narrowing toward the speaker. */}
      <div style={{ width: tail * 2, height: tail, background: CHATTER_BUBBLE_BORDER }} />
      <div style={{ width: tail, height: tail, background: CHATTER_BUBBLE_BORDER }} />
    </div>
  );
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  subagentTools,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
  onRemoveResident,
  alwaysShowOverlay,
}: ToolOverlayProps) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let rafId = 0;
    const tick = () => {
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const el = containerRef.current;
  if (!el) return null;
  // dpr is also needed to size the bubble canvases in CSS px (OverlayBubble).
  const dpr = window.devicePixelRatio || 1;
  const project = overlayProjection(
    officeState.getLayout(),
    el.getBoundingClientRect(),
    zoom,
    panRef.current,
    dpr,
  );

  const selectedId = officeState.selectedAgentId;
  const hoveredId = officeState.hoveredAgentId;

  // All character IDs: agents, sub-agents, and Residents hosting no agent.
  const residentIds = officeState.getUnboundResidentIds();
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id), ...residentIds];
  // Chatter text scales with the office (about 6 sprite px), clamped to stay legible.
  const chatterFontSize = Math.min(22, Math.max(12, Math.round((6 * zoom) / dpr)));

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id);
        if (!ch) return null;

        const isSelected = selectedId === id;
        const isHovered = hoveredId === id;
        const isSub = ch.isSubagent;

        // Speech bubble (permission dots / done checkmark) — rendered here in
        // the DOM, above the label panels (OVERLAY_BUBBLE_Z_INDEX over the label panels), for every
        // character regardless of label visibility. Mirrors the geometry the
        // canvas renderer used. The idle "Waiting for input" state speaks
        // through its label, not a bubble.
        let bubbleNode = null;
        if (ch.bubbleType && !(ch.bubbleType === 'waiting' && ch.waitingAwaitingInput)) {
          const cachedBubble = getCachedSprite(
            ch.bubbleType === 'permission' ? BUBBLE_PERMISSION_SPRITE : BUBBLE_WAITING_SPRITE,
            zoom,
          );
          const bubbleSittingOff = ch.state === CharacterState.TYPE ? BUBBLE_SITTING_OFFSET_PX : 0;
          const alpha =
            ch.bubbleType === 'waiting' && ch.bubbleTimer < BUBBLE_FADE_DURATION_SEC
              ? ch.bubbleTimer / BUBBLE_FADE_DURATION_SEC
              : 1;
          bubbleNode = (
            <div
              className="absolute -translate-x-1/2 pointer-events-none"
              style={{
                left: project.toScreenX(ch.x),
                // Bubble bottom sits one sprite pixel above the character's
                // anchor: project the anchor, then lift by the bubble's own
                // device-pixel height plus one zoomed pixel, in CSS px.
                top:
                  project.toScreenY(ch.y + bubbleSittingOff - BUBBLE_VERTICAL_OFFSET_PX) -
                  (cachedBubble.height + zoom) / dpr,
                opacity: alpha,
                zIndex: OVERLAY_BUBBLE_Z_INDEX,
              }}
            >
              <OverlayBubble cached={cachedBubble} dpr={dpr} />
            </div>
          );
        }

        const isFreeResident = officeState.isUnboundResident(id);
        const labelShown = alwaysShowOverlay || isSelected || isHovered;

        // Binary chatter while roaming: above the head, lifted clear of the
        // label panel when one shows. Never drawn with a status bubble up.
        let chatterNode = null;
        if (chatterVisible(ch)) {
          const sitOff = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
          chatterNode = (
            <ChatterBubble
              ch={ch}
              left={project.toScreenX(ch.x)}
              bottom={
                project.toScreenY(ch.y + sitOff - CHATTER_BUBBLE_RISE_WORLD) -
                (labelShown ? CHATTER_LABEL_CLEARANCE_PX : 0)
              }
              fontSize={chatterFontSize}
            />
          );
        }

        // Only show the label for hovered or selected agents (unless
        // always-show is on); the bubbles render regardless.
        if (!labelShown) {
          if (!bubbleNode && !chatterNode) return null;
          return (
            <Fragment key={id}>
              {chatterNode}
              {bubbleNode}
            </Fragment>
          );
        }

        // A Resident hosting no agent: its name (or type) and, selected, the
        // remove button. It has no tools, terminal or context to show.
        if (isFreeResident) {
          const residentId = ch.residentId;
          return (
            <Fragment key={id}>
              {chatterNode}
              <div
                className="absolute flex flex-col items-center -translate-x-1/2"
                style={{
                  left: project.toScreenX(ch.x),
                  top: project.toScreenY(ch.y - TOOL_OVERLAY_VERTICAL_OFFSET) - 28,
                  pointerEvents: isSelected ? 'auto' : 'none',
                  opacity: alwaysShowOverlay && !isSelected && !isHovered ? 0.75 : 1,
                  zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
                }}
                data-testid="resident-overlay"
                data-resident-id={residentId}
              >
                <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{ fontSize: '22px', color: RESIDENT_NAME_COLOR }}
                  >
                    {residentDisplayName({
                      name: ch.residentName,
                      providerId: ch.providerId ?? DEFAULT_PROVIDER_ID,
                    })}
                  </span>
                  {isSelected && residentId && onRemoveResident && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveResident(residentId);
                      }}
                      title="Remove resident"
                      className="ml-2 shrink-0 leading-none"
                    >
                      ×
                    </Button>
                  )}
                </div>
              </div>
            </Fragment>
          );
        }

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
        const screenX = project.toScreenX(ch.x);
        const screenY = project.toScreenY(ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET);

        // A "Done" agent (finished turn: waiting bubble without awaitingInput)
        // shows ONLY its floating green checkmark bubble, never the label panel
        // (the panel would cover the bubble). Render an empty positioned marker
        // so overlay counts stay stable and hover/select can still bring the
        // panel back. When always-show is off, the early return above already
        // keeps the panel hidden for idle agents.
        const isDone = ch.bubbleType === 'waiting' && !ch.waitingAwaitingInput;
        if (isDone && !isSelected && !isHovered) {
          return (
            <Fragment key={id}>
              {chatterNode}
              {bubbleNode}
              <div
                className="absolute"
                style={{ left: screenX, top: screenY, pointerEvents: 'none' }}
                data-testid="agent-overlay"
                data-agent-id={id}
              />
            </Fragment>
          );
        }

        // Get activity text
        const hasWaitingBubble = ch.bubbleType === 'waiting';
        const subHasPermission = isSub && ch.bubbleType === 'permission';
        let activityText: string;
        if (hasWaitingBubble && ch.waitingAwaitingInput) {
          // Idle, waiting on the user -> dedicated label. A finished turn (Stop)
          // shows only the checkmark and falls through to the normal idle text.
          activityText = WAITING_INPUT_ACTIVITY_TEXT;
        } else if (isSub) {
          if (subHasPermission) {
            activityText = 'Needs approval';
          } else {
            // Hover shows the subtask title; SELECTING the sub reveals its live
            // tool activity (watched sub-agents stream it via subagentToolStart).
            const sub = subagentCharacters.find((s) => s.id === id);
            const rows = sub ? subagentTools[sub.parentAgentId]?.[sub.parentToolId] : undefined;
            const activeRow =
              isSelected && rows ? [...rows].reverse().find((t) => !t.done) : undefined;
            activityText = activeRow?.status ?? (sub?.label || 'Subtask');
          }
        } else {
          activityText = getActivityText(
            id,
            agentTools,
            ch.isActive,
            ch.bubbleType,
            ch.waitingAwaitingInput ?? false,
          );
        }

        // Determine dot color
        const tools = agentTools[id];
        const hasPermission = subHasPermission || tools?.some((t) => t.permissionWait && !t.done);
        const hasActiveTools = tools?.some((t) => !t.done);
        const isActive = ch.isActive;
        const hasWaiting = ch.bubbleType === 'waiting';

        let dotColor: string | null = null;
        if (hasPermission || hasWaiting) {
          dotColor = 'var(--color-status-permission)';
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--color-status-active)';
        }

        // Team info
        const teamRoleLabel = ch.isTeamLead ? 'LEAD' : ch.agentName || null;
        // A Resident hosting the agent shows its name in the role slot when
        // there is no team role; non-Claude agents carry their own label
        // ("Codex · my-project") in place of the directory line.
        const roleLine = teamRoleLabel ?? ch.residentName ?? null;
        const originLine = ch.agentLabel ?? ch.directoryName ?? null;
        const hasExtraLines = !!(originLine || roleLine);

        // Context gauge. Every agent gets one — lead, teammate, adopted,
        // headless — as soon as it has taken a turn. Sub-agents never do: they
        // have no session of their own, so contextTokens stays 0.
        const contextRatio = ch.contextTokens / ch.maxContextTokens;
        const showContextGauge = !isSub && ch.contextTokens > 0;

        return (
          <Fragment key={id}>
            {chatterNode}
            {bubbleNode}
            <div
              className="absolute flex flex-col items-center -translate-x-1/2"
              style={{
                left: screenX,
                top: screenY - (hasExtraLines ? 34 : 28),
                pointerEvents: isSelected ? 'auto' : 'none',
                opacity: alwaysShowOverlay && !isSelected && !isHovered ? (isSub ? 0.5 : 0.75) : 1,
                zIndex: isSelected ? OVERLAY_LABEL_SELECTED_Z_INDEX : OVERLAY_LABEL_Z_INDEX,
              }}
              data-testid="agent-overlay"
              data-agent-id={id}
            >
              <div className="flex items-center border-border px-8 pt-2 pb-4 gap-5 pixel-panel whitespace-nowrap max-w-2xs">
                {dotColor && (
                  <span
                    className={`w-6 h-6 rounded-full shrink-0 ${isActive && !hasPermission && !hasWaiting ? 'pixel-pulse' : ''}`}
                    style={{ background: dotColor }}
                  />
                )}
                <div className="flex flex-col gap-0 overflow-hidden">
                  {roleLine && (
                    <span
                      className="overflow-hidden text-ellipsis block leading-none"
                      style={{
                        fontSize: '18px',
                        color: !teamRoleLabel
                          ? RESIDENT_NAME_COLOR
                          : ch.isTeamLead
                            ? TEAM_LEAD_COLOR
                            : TEAM_ROLE_COLOR,
                        fontWeight: ch.isTeamLead ? 'bold' : undefined,
                      }}
                    >
                      {roleLine}
                    </span>
                  )}
                  <span
                    className="overflow-hidden text-ellipsis block leading-none"
                    style={{
                      fontSize: isSub ? '20px' : '22px',
                      fontStyle: isSub ? 'italic' : undefined,
                    }}
                  >
                    {activityText}
                  </span>
                  {originLine && (
                    <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                      {originLine}
                    </span>
                  )}
                </div>
                {isSelected && !isSub && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseAgent(id);
                    }}
                    title="Close agent"
                    className="ml-2 shrink-0 leading-none"
                  >
                    ×
                  </Button>
                )}
              </div>
              {showContextGauge && (
                <div
                  style={{
                    width: CONTEXT_GAUGE_WIDTH_PX,
                    height: CONTEXT_GAUGE_HEIGHT_PX,
                    background: CONTEXT_GAUGE_BG,
                    marginTop: 2,
                  }}
                  title={`${Math.round(contextRatio * 100)}% context used (${(ch.contextTokens / 1000).toFixed(0)}k of ${(ch.maxContextTokens / 1000).toFixed(0)}k tokens)`}
                  data-testid="context-gauge"
                  data-context-pct={Math.round(contextRatio * 100)}
                >
                  <div
                    style={{
                      width: `${Math.min(contextRatio * 100, 100)}%`,
                      height: '100%',
                      background: getFuelColor(contextRatio),
                    }}
                  />
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
    </>
  );
}
