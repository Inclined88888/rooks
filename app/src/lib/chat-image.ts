'use client';

/**
 * Shrinks an image before it joins a chat turn (TIM-0125).
 *
 * Images travel base64-encoded inside the JSON body of the turn, which the
 * daemon caps at 25 MB (`orchestrator/src/kernel/body-parser.ts`): ten phone
 * photos of ~2.5 MB each did not fit. The models downscale everything to
 * ~1568 px on their side anyway, so a 2048 px JPEG loses nothing they would
 * have seen, and weighs 200–500 KB instead of several MB.
 *
 * Same reasoning as `image-upload.ts` for doing it here rather than in the
 * daemon: the orchestrator has no native image library.
 *
 * The canvas work sits behind `ChatImageCodec` so the decision logic can be
 * tested without a browser: jsdom has neither `createImageBitmap` nor a 2D
 * canvas.
 */

/** Longest side kept. Above what any model looks at, below a phone photo. */
export const CHAT_IMAGE_MAX_PX = 2048;
export const CHAT_IMAGE_JPEG_QUALITY = 0.85;

/** Types that can carry an alpha channel: only those are checked for it. */
const MAY_HAVE_ALPHA = new Set(['image/png', 'image/webp', 'image/gif', 'image/avif']);
/** Types every model accepts inline: an original of one of these that the
 *  re-encode did not shrink is sent as it was. */
const MODEL_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type RenderedImage = {
  /** Does any pixel of the drawn image have alpha < 255? */
  hasAlpha(): boolean;
  encode(type: string, quality?: number): Promise<Blob | null>;
};

export type LoadedImage = {
  width: number;
  height: number;
  render(width: number, height: number): RenderedImage;
  close(): void;
};

export type ChatImageCodec = {
  /** Null when the browser cannot decode the file (HEIC outside Safari, a
   *  corrupt file…): the original is then sent untouched. */
  load(file: Blob): Promise<LoadedImage | null>;
};

export type ChatImage = { blob: Blob; mediaType: string };

/** Size that fits in `max`×`max`, ratio preserved, never enlarged. */
export function fitWithin(width: number, height: number, max = CHAT_IMAGE_MAX_PX): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** RGBA pixel data: is any alpha byte below opaque? */
export function hasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 255) < 255) return true;
  }
  return false;
}

const browserCodec: ChatImageCodec = {
  async load(file) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return null;
    }
    return {
      width: bitmap.width,
      height: bitmap.height,
      render(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('canvas 2d unavailable');
        ctx.drawImage(bitmap, 0, 0, width, height);
        return {
          hasAlpha: () => hasTransparency(ctx.getImageData(0, 0, width, height).data),
          encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
        };
      },
      close: () => bitmap.close(),
    };
  },
};

/**
 * Longest side ≤ `CHAT_IMAGE_MAX_PX`, re-encoded as JPEG — or PNG when the
 * image really uses transparency, which JPEG would paint black. Any failure
 * returns the original: a picture sent heavier beats a picture lost.
 */
export async function compressForChat(file: File, codec: ChatImageCodec = browserCodec): Promise<ChatImage> {
  const original: ChatImage = { blob: file, mediaType: file.type || 'image/png' };
  let loaded: LoadedImage | null = null;
  try {
    loaded = await codec.load(file);
    if (!loaded) return original;
    const size = fitWithin(loaded.width, loaded.height);
    const resized = size.width !== loaded.width || size.height !== loaded.height;
    const rendered = loaded.render(size.width, size.height);
    const keepPng = MAY_HAVE_ALPHA.has(file.type) && rendered.hasAlpha();
    const mediaType = keepPng ? 'image/png' : 'image/jpeg';
    const blob = await rendered.encode(mediaType, keepPng ? undefined : CHAT_IMAGE_JPEG_QUALITY);
    if (!blob || blob.size === 0) return original;
    // A small screenshot already well compressed can come out heavier.
    if (!resized && blob.size >= file.size && MODEL_TYPES.has(file.type)) return original;
    return { blob, mediaType };
  } catch {
    return original;
  } finally {
    loaded?.close();
  }
}
