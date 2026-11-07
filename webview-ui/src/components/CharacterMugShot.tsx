import { useEffect, useRef, useSyncExternalStore } from 'react';

import { getClaudeSkin, subscribeClaudeSkin } from '../claudeSkin.js';
import {
  MUGSHOT_CROP_LEFT_COL,
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_CROP_TOP_ROW,
  MUGSHOT_DISPLAY_PX,
  MUGSHOT_RENDER_ZOOM,
} from '../constants.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getSpritesForLook } from '../office/sprites/spriteData.js';
import { Direction } from '../office/types.js';

interface CharacterMugShotProps {
  palette: number;
  hueShift: number;
  /** Agent type: its own skin is used when loaded (palette is the fallback). */
  providerId?: string;
  /** Hue shift of the per-type skin. */
  skinHue?: number;
  /** On-screen side length in CSS px. Defaults to MUGSHOT_DISPLAY_PX. */
  size?: number;
}

/**
 * A square "mug shot" — the head region of an agent's front-facing sprite,
 * scaled up crisply. Used as the terminal tab's identity in place of a label.
 *
 * Reuses the office sprite cache: the full front sprite is rendered once per
 * look (palette:hueShift, or skin:<provider>:<hue>), and we blit just the head square out of it.
 */
export function CharacterMugShot({
  palette,
  hueShift,
  providerId,
  skinHue,
  size = MUGSHOT_DISPLAY_PX,
}: CharacterMugShotProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Re-draw when the Claude skin choice changes (getSpritesForLook reads it).
  const claudeSkin = useSyncExternalStore(subscribeClaudeSkin, getClaudeSkin);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const front = getSpritesForLook({ palette, hueShift, providerId, skinHue }).walk[
      Direction.DOWN
    ][0];
    const full = getCachedSprite(front, MUGSHOT_RENDER_ZOOM);

    const side = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
    canvas.width = side;
    canvas.height = side;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(
      full,
      MUGSHOT_CROP_LEFT_COL * MUGSHOT_RENDER_ZOOM,
      MUGSHOT_CROP_TOP_ROW * MUGSHOT_RENDER_ZOOM,
      side,
      side,
      0,
      0,
      side,
      side,
    );
  }, [palette, hueShift, providerId, skinHue, claudeSkin]);

  return (
    <canvas
      ref={canvasRef}
      width={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      height={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
      style={{ width: size, height: size, imageRendering: 'pixelated' }}
    />
  );
}
