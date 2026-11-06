'use client';

/**
 * Client-side image downscaling, shared by every picker that stores a picture
 * through `/api/uploads/…` (project icons, agent avatars, profile pictures).
 *
 * The downscale happens here and not in the daemon on purpose: the
 * orchestrator has no native image lib (`sharp`/`jimp`) and is not about to
 * grow one for a 256px thumbnail — `orchestrator/src/uploads.ts` says the same
 * from the other side, and its 2 MB cap assumes this ran.
 *
 * Two verbatim copies of this function lived in `projects-page.tsx` and
 * `edit-client.tsx`; a third one was about to appear with the profile page.
 */

/** Consistent with the chat's image upload limit. */
export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024;
/** Largest side kept. An icon or an avatar never needs more. */
export const MAX_IMAGE_PX = 256;

/** Loads an image, shrinks it so its longest side is ≤ `MAX_IMAGE_PX` (ratio
 *  preserved) and returns a PNG data URL (keeps transparency). */
export async function downscaleToDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/png');
  } finally {
    bitmap.close();
  }
}

/**
 * Downscales then posts to an uploads endpoint, returning the service URL the
 * caller persists. Throws with the daemon's own wording when it refuses.
 */
export async function uploadImage(endpoint: string, file: File): Promise<string> {
  return uploadDataUrl(endpoint, await downscaleToDataUrl(file));
}

/**
 * Posts an already-composed image (the logo cropper builds its own PNG) and
 * returns the service URL. `uploadImage` is the same call with a downscale in
 * front of it.
 */
export async function uploadDataUrl(endpoint: string, dataUrl: string): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${response.status}`);
  }
  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new Error('upload returned no url');
  return body.url;
}
