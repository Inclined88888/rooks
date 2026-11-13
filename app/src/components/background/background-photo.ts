export type BackgroundPhotoErrorCode = 'format' | 'fileSize' | 'decode' | 'encode' | 'network' | 'session' | 'unavailable' | 'server' | 'storage';
export class BackgroundPhotoError extends Error {
  constructor(public readonly code: BackgroundPhotoErrorCode, public readonly status?: number) {
    super(code);
    this.name = 'BackgroundPhotoError';
  }
}

/** Some file pickers supply image/jpg, an empty MIME type or octet-stream.
 * Extensions are only a hint; the browser must still decode the actual bytes. */
export function validateBackgroundPhoto(file: Pick<File, 'type' | 'size' | 'name'>): void {
  if (file.size > 25 * 1024 * 1024) throw new BackgroundPhotoError('fileSize');
  const mime = file.type.toLowerCase();
  const known = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif'];
  const unnamed = (!mime || mime === 'application/octet-stream') && /\.(jpe?g|png|webp|gif)$/i.test(file.name);
  if (!known.includes(mime) && !unnamed) throw new BackgroundPhotoError('format');
}

async function decodePhoto(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  try {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
  } catch { /* The image element decoder supports additional JPEG profiles. */ }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new BackgroundPhotoError('decode'));
      img.src = url;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new BackgroundPhotoError('decode');
  }
}

/** Resize locally before upload: bounded raster data without EXIF metadata. */
export async function prepareBackgroundPhoto(file: File): Promise<string> {
  validateBackgroundPhoto(file);
  const image = await decodePhoto(file);
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new BackgroundPhotoError('encode');
    // High-detail photos can exceed the daemon's 2 MB limit even at reduced
    // JPEG quality. Reduce dimensions too, rather than rejecting a valid file.
    for (const maxSide of [2560, 1920, 1280]) {
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72, 0.55]) {
        const data = canvas.toDataURL('image/jpeg', quality);
        if (data.startsWith('data:image/jpeg;base64,') && data.length < 2.6 * 1024 * 1024) return data;
      }
    }
    throw new BackgroundPhotoError('encode');
  } finally { image.close(); }
}

/** Keep file errors distinct from HTTP errors: an old daemon's 404 says
 * nothing about the format or size of the user's photograph. */
export async function uploadBackgroundPhoto(dataUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl('/api/ui/appearance/background-image', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl }),
    });
  } catch { throw new BackgroundPhotoError('network'); }
  if (response.status === 401 || response.status === 403) throw new BackgroundPhotoError('session', response.status);
  if (response.status === 404 || response.status === 405) throw new BackgroundPhotoError('unavailable', response.status);
  if (response.status === 413) throw new BackgroundPhotoError('encode', response.status);
  if (response.status === 502 || response.status === 503 || response.status === 504) throw new BackgroundPhotoError('network', response.status);
  const body = await response.json().catch(() => null) as { url?: unknown; error?: unknown } | null;
  if (!response.ok) {
    if (typeof body?.error === 'string' && /EACCES|ENOSPC|EROFS|disk|storage/i.test(body.error)) throw new BackgroundPhotoError('storage', response.status);
    throw new BackgroundPhotoError('server', response.status);
  }
  const url = body?.url;
  if (typeof url !== 'string' || !/^\/api\/ui\/appearance\/background-image\/[a-f0-9-]+\.(jpg|png|webp|gif)$/.test(url)) {
    throw new BackgroundPhotoError('server', response.status);
  }
  return url;
}
