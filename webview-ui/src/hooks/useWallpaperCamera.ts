import { useEffect, useRef, useState } from 'react';

import { WALLPAPER_LAYOUT_POLL_MS } from '../constants.js';
import type { OfficeLayout } from '../office/types.js';
import { computeWallpaperCamera } from '../wallpaper.js';

/**
 * Wallpaper mode's fixed camera: the zoom and pan that fit the whole office
 * into `containerRef`'s box, recomputed on resize (and DPR changes, which fire
 * resize) and when the layout's extent changes. The layout lives outside React,
 * so its extent is re-checked on a slow poll. The returned pan ref is the one
 * the canvas and overlays draw with; nothing else writes it.
 *
 * Inert (no listeners, no timer) when `enabled` is false. `ready` re-runs the
 * fit once the real layout (and the container) has mounted.
 */
export function useWallpaperCamera(
  enabled: boolean,
  ready: boolean,
  getLayout: () => OfficeLayout,
  containerRef: React.RefObject<HTMLDivElement | null>,
  forcedZoom: number | null,
): { zoom: number; panRef: React.MutableRefObject<{ x: number; y: number }> } {
  const [zoom, setZoom] = useState(1);
  const panRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      const el = containerRef.current;
      const dpr = window.devicePixelRatio || 1;
      const rect = el
        ? el.getBoundingClientRect()
        : { width: window.innerWidth, height: window.innerHeight };
      const camera = computeWallpaperCamera(
        getLayout(),
        Math.round(rect.width * dpr),
        Math.round(rect.height * dpr),
        forcedZoom,
      );
      panRef.current = camera.pan;
      setZoom(camera.zoom);
    };
    update();
    window.addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    if (containerRef.current) observer.observe(containerRef.current);
    const timer = window.setInterval(update, WALLPAPER_LAYOUT_POLL_MS);
    return () => {
      window.removeEventListener('resize', update);
      observer.disconnect();
      window.clearInterval(timer);
    };
  }, [enabled, ready, getLayout, containerRef, forcedZoom]);

  return { zoom, panRef };
}
