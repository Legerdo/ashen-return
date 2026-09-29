/**
 * The single coordinate module. Cursor → world, targeting, muzzle, throw preview, and tile/sprite placement
 * all go through these functions.
 *
 *   S = C + k × (16x, 16y − 16z)
 *   x = (Sx − Cx) / (16k)
 *   y = (Sy − Cy) / (16k) + z        (only for a given z)
 */
export const TILE_PX = 16;
export const VIEW_W = 640;
export const VIEW_H = 360;

export interface ViewCamera {
  /** Screen position (view px) of world origin. */
  cx: number;
  cy: number;
  /** Zoom factor k. */
  k: number;
}

export interface ViewPoint {
  sx: number;
  sy: number;
}

export function worldToView(cam: ViewCamera, x: number, y: number, z: number): ViewPoint {
  return { sx: cam.cx + cam.k * TILE_PX * x, sy: cam.cy + cam.k * (TILE_PX * y - TILE_PX * z) };
}

export function viewToWorld(cam: ViewCamera, sx: number, sy: number, z: number): { x: number; y: number } {
  return { x: (sx - cam.cx) / (TILE_PX * cam.k), y: (sy - cam.cy) / (TILE_PX * cam.k) + z };
}

/** World pixel coordinates used for sprite placement (k = 1, origin at world 0,0). */
export function worldPx(x: number, y: number, z: number): { px: number; py: number } {
  return { px: TILE_PX * x, py: TILE_PX * y - TILE_PX * z };
}

/** Camera so that world ground point (fx, fy) lands at view center. */
export function cameraCenteredOn(fx: number, fy: number, k = 1, viewW = VIEW_W, viewH = VIEW_H): ViewCamera {
  return { cx: viewW / 2 - k * TILE_PX * fx, cy: viewH / 2 - k * TILE_PX * fy, k };
}

/** Clamp a camera focus so the view stays inside map bounds (in units). */
export function clampFocus(fx: number, fy: number, mapW: number, mapH: number, k = 1): { fx: number; fy: number } {
  const halfW = VIEW_W / (2 * TILE_PX * k);
  const halfH = VIEW_H / (2 * TILE_PX * k);
  const minX = halfW - 2;
  const maxX = mapW - halfW + 2;
  const minY = halfH - 4;
  const maxY = mapH - halfH + 2;
  return {
    fx: minX > maxX ? mapW / 2 : Math.min(maxX, Math.max(minX, fx)),
    fy: minY > maxY ? mapH / 2 : Math.min(maxY, Math.max(minY, fy)),
  };
}

/** CSS-pixel rectangle of the displayed canvas (getBoundingClientRect). */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function clientToView(rect: DisplayRect, clientX: number, clientY: number, viewW = VIEW_W, viewH = VIEW_H): ViewPoint {
  const w = rect.width > 0 ? rect.width : viewW;
  const h = rect.height > 0 ? rect.height : viewH;
  return { sx: ((clientX - rect.left) * viewW) / w, sy: ((clientY - rect.top) * viewH) / h };
}

export function viewToClient(rect: DisplayRect, sx: number, sy: number, viewW = VIEW_W, viewH = VIEW_H): { clientX: number; clientY: number } {
  return { clientX: rect.left + (sx * rect.width) / viewW, clientY: rect.top + (sy * rect.height) / viewH };
}

export interface CanvasLayout {
  /** Physical-pixel scale factor of the 640×360 backing (integer when the window allows it). */
  scale: number;
  integer: boolean;
  cssWidth: number;
  cssHeight: number;
  cssLeft: number;
  cssTop: number;
}

/**
 * Integer physical scaling with letterbox. Uses device pixels so each world pixel maps to an exact
 * scale×scale block on screen regardless of devicePixelRatio.
 */
export function computeCanvasLayout(windowW: number, windowH: number, dpr: number, viewW = VIEW_W, viewH = VIEW_H): CanvasLayout {
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const physW = Math.max(1, Math.floor(windowW * ratio));
  const physH = Math.max(1, Math.floor(windowH * ratio));
  const fit = Math.min(physW / viewW, physH / viewH);
  const integer = fit >= 1;
  const scale = integer ? Math.floor(fit) : fit;
  const outW = viewW * scale;
  const outH = viewH * scale;
  return {
    scale,
    integer,
    cssWidth: outW / ratio,
    cssHeight: outH / ratio,
    cssLeft: Math.floor((physW - outW) / 2) / ratio,
    cssTop: Math.floor((physH - outH) / 2) / ratio,
  };
}
