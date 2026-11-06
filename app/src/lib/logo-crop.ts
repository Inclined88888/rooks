/**
 * Round-logo framing: the maths behind the picker's crop, kept out of the
 * component so the preview and the exported image share one implementation
 * and so the clamping can be tested without a canvas.
 *
 * Everything is expressed in output pixels (a square of `LOGO_OUTPUT_PX`).
 * The preview is the same square drawn smaller, so what you see while
 * dragging is exactly what gets uploaded.
 */

/** Stored logos are square; the circle is a CSS mask at display time. */
export const LOGO_OUTPUT_PX = 256;

/**
 * Zoom 1 means "cover". The range goes well below it because a logo often has
 * to *shrink* to fit inside the circle — a wide wordmark at cover is already
 * cropped on both sides, and there was no way down.
 */
export const MIN_LOGO_ZOOM = 0.15;
export const MAX_LOGO_ZOOM = 4;

export type LogoCrop = {
  /** 1 = the image covers the square exactly. */
  zoom: number;
  /** Offset of the image centre, in output pixels. */
  offsetX: number;
  offsetY: number;
  /** Hex colour painted under the image, `null` to keep transparency. */
  background: string | null;
};

export const DEFAULT_CROP: LogoCrop = { zoom: 1, offsetX: 0, offsetY: 0, background: null };

export type SourceSize = { width: number; height: number };

/** Scale at which the source covers the square (its shortest side fills it). */
export function coverScale(source: SourceSize, size = LOGO_OUTPUT_PX): number {
  const shortest = Math.min(source.width, source.height);
  return shortest > 0 ? size / shortest : 1;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_LOGO_ZOOM, Math.max(MIN_LOGO_ZOOM, zoom));
}

/** Zoom at which the whole source fits inside the square, margins included.
 *  For a square source it is 1; for a wide one it is below. */
export function containZoom(source: SourceSize): number {
  const longest = Math.max(source.width, source.height);
  const shortest = Math.min(source.width, source.height);
  return longest > 0 ? shortest / longest : 1;
}

/**
 * Where a freshly loaded image starts. A picture is framed edge to edge; a
 * logo — which is what a transparent PNG almost always is — starts whole,
 * with a little air around it, because that is the shape it was drawn for.
 */
export function initialCrop(source: SourceSize, transparent: boolean): LogoCrop {
  return transparent
    ? { ...DEFAULT_CROP, zoom: containZoom(source) * 0.92 }
    : DEFAULT_CROP;
}

/**
 * Bounds panning by the distance between the drawn image and the square: when
 * the image overflows, it stops where a gap would appear; when it is smaller
 * than the frame, it stops at the frame's edge instead of drifting out of it.
 */
export function clampOffset(
  source: SourceSize,
  crop: LogoCrop,
  size = LOGO_OUTPUT_PX,
): { offsetX: number; offsetY: number } {
  const scale = coverScale(source, size) * clampZoom(crop.zoom);
  const slackX = Math.abs(source.width * scale - size) / 2;
  const slackY = Math.abs(source.height * scale - size) / 2;
  // `|| 0` also turns the `-0` that clamping to a zero slack produces into a
  // plain 0 — harmless to draw, but it leaks into equality checks.
  return {
    offsetX: Math.min(slackX, Math.max(-slackX, crop.offsetX || 0)) || 0,
    offsetY: Math.min(slackY, Math.max(-slackY, crop.offsetY || 0)) || 0,
  };
}

export function normalizeCrop(source: SourceSize, crop: LogoCrop, size = LOGO_OUTPUT_PX): LogoCrop {
  const zoom = clampZoom(crop.zoom);
  const { offsetX, offsetY } = clampOffset(source, { ...crop, zoom }, size);
  return { zoom, offsetX, offsetY, background: crop.background };
}

/** Where the source lands in the output square, once framed. */
export function drawRect(
  source: SourceSize,
  crop: LogoCrop,
  size = LOGO_OUTPUT_PX,
): { x: number; y: number; width: number; height: number } {
  const normalized = normalizeCrop(source, crop, size);
  const scale = coverScale(source, size) * normalized.zoom;
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (size - width) / 2 + normalized.offsetX,
    y: (size - height) / 2 + normalized.offsetY,
    width,
    height,
  };
}

/** Paints the framed logo into a square canvas context. */
export function drawLogo(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & SourceSize,
  crop: LogoCrop,
  size = LOGO_OUTPUT_PX,
): void {
  ctx.clearRect(0, 0, size, size);
  if (crop.background) {
    ctx.fillStyle = crop.background;
    ctx.fillRect(0, 0, size, size);
  }
  const rect = drawRect(image, crop, size);
  ctx.drawImage(image, rect.x, rect.y, rect.width, rect.height);
}
