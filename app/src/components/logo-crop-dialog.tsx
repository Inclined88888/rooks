'use client';

/**
 * Framing dialog for every logo and avatar of the product.
 *
 * A square logo dropped into a round bubble is what this exists for: the chat
 * shows agents in circles, so an image has to be zoomed and panned *before*
 * being stored, and a PNG with a transparent background needs a colour under
 * it or it turns into a hole.
 *
 * The framing is baked into the uploaded image rather than stored as metadata
 * (decision of 12/09/2026): every surface that already draws `icon` — badges,
 * avatars, chat bubbles, cockpit — gets the right picture without knowing
 * this dialog exists.
 *
 * The preview is the same `drawLogo()` the export uses, at a smaller size, so
 * what is dragged is exactly what is uploaded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { uploadDataUrl, MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import {
  containZoom,
  DEFAULT_CROP,
  drawLogo,
  initialCrop,
  LOGO_OUTPUT_PX,
  MAX_LOGO_ZOOM,
  MIN_LOGO_ZOOM,
  normalizeCrop,
  type LogoCrop,
} from '@/lib/logo-crop';

/** Side of the on-screen preview, in CSS pixels. */
const PREVIEW_PX = 184;

/**
 * True when the image carries meaningful transparency — the signal that it is
 * a logo rather than a photo, and so that it should start whole inside the
 * circle instead of edge to edge.
 *
 * Sampled on a small canvas: reading 64×64 pixels answers the question as well
 * as reading four megapixels.
 */
function hasTransparency(image: HTMLImageElement): boolean {
  const probe = document.createElement('canvas');
  probe.width = 64;
  probe.height = 64;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, 64, 64);
  try {
    const { data } = ctx.getImageData(0, 0, 64, 64);
    let clear = 0;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] ?? 255) < 250) clear += 1;
    }
    // A couple of soft edges are not a transparent background; a corner's
    // worth of empty pixels is.
    return clear > 64 * 64 * 0.08;
  } catch {
    // Tainted canvas (a logo served by a third party without CORS): treat it
    // as opaque rather than refusing the framing altogether.
    return false;
  }
}

export type LogoCropSource = File | string;

export type LogoCropDialogProps = {
  /** The image to frame — a freshly picked file or an already stored URL.
   *  `null` keeps the dialog closed. */
  source: LogoCropSource | null;
  /** Upload endpoint; the composed PNG is posted as a data URL. */
  endpoint: string;
  /** Offered as the first background swatch — usually the project colour. */
  suggestedBackground?: string | null;
  onCancel: () => void;
  onUploaded: (url: string) => void;
};

export function LogoCropDialog({
  source,
  endpoint,
  suggestedBackground,
  onCancel,
  onUploaded,
}: LogoCropDialogProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<LogoCrop>(DEFAULT_CROP);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  // Callers pass inline lambdas, so `onCancel` is a new function on every
  // render of their own. Keeping it in a ref is what stops the loading effect
  // below from re-running — it reloads the image and resets zoom, pan and
  // background, which is how a half-adjusted logo used to snap back mid-edit.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Load the source. A File goes through an object URL rather than
  // `createImageBitmap` so both branches end on the same HTMLImageElement.
  useEffect(() => {
    if (!source) {
      setImage(null);
      setFailed(false);
      setCrop(DEFAULT_CROP);
      return;
    }
    if (source instanceof File && source.size > MAX_IMAGE_UPLOAD_BYTES) {
      toast.error(t('logoCrop.imageTooLarge'));
      onCancelRef.current();
      return;
    }
    let cancelled = false;
    const objectUrl = source instanceof File ? URL.createObjectURL(source) : null;
    const img = new Image();
    // Needed to keep the canvas untainted when re-framing a logo that lives on
    // another origin; same-origin uploads are unaffected.
    if (!objectUrl) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      setImage(img);
      setCrop(initialCrop(img, hasTransparency(img)));
    };
    img.onerror = () => {
      if (!cancelled) setFailed(true);
    };
    img.src = objectUrl ?? (source as string);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Only the source belongs here: anything else reloads a picture the user
    // is in the middle of framing.
  }, [source]);

  // One draw per state change, at preview scale.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !image) return;
    // `image.width/height` of a detached image are its natural dimensions.
    drawLogo(ctx, image, crop, LOGO_OUTPUT_PX);
  }, [image, crop]);

  const size = image ? { width: image.naturalWidth, height: image.naturalHeight } : null;

  const move = useCallback(
    (dx: number, dy: number) => {
      if (!size) return;
      // Screen pixels → output pixels, so dragging tracks the cursor exactly.
      const factor = LOGO_OUTPUT_PX / PREVIEW_PX;
      setCrop((c) =>
        normalizeCrop(size, { ...c, offsetX: c.offsetX + dx * factor, offsetY: c.offsetY + dy * factor }),
      );
    },
    [size],
  );

  async function apply() {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    setSaving(true);
    try {
      const url = await uploadDataUrl(endpoint, canvas.toDataURL('image/png'));
      onUploaded(url);
    } catch (e) {
      toast.error(String((e as Error).message || e).slice(0, 120));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={source !== null} onOpenChange={(v) => { if (!v && !saving) onCancel(); }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{t('logoCrop.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          <div
            className="relative touch-none rounded-full border border-border"
            // Checkerboard: the only way to tell a transparent logo from a
            // white one before it lands on a dark background.
            style={{
              width: PREVIEW_PX,
              height: PREVIEW_PX,
              backgroundImage:
                'repeating-conic-gradient(rgba(128,128,128,0.22) 0% 25%, transparent 0% 50%)',
              backgroundSize: '16px 16px',
            }}
          >
            <canvas
              ref={canvasRef}
              width={LOGO_OUTPUT_PX}
              height={LOGO_OUTPUT_PX}
              className="size-full cursor-grab rounded-full active:cursor-grabbing"
              onPointerDown={(e) => {
                dragRef.current = { x: e.clientX, y: e.clientY };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                const from = dragRef.current;
                if (!from) return;
                move(e.clientX - from.x, e.clientY - from.y);
                dragRef.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerUp={() => { dragRef.current = null; }}
              onPointerCancel={() => { dragRef.current = null; }}
            />
            {!image && (
              <div className="absolute inset-0 grid place-items-center rounded-full bg-background/70 text-[11px] text-muted-foreground">
                {failed ? t('logoCrop.loadFailed') : t('logoCrop.loading')}
              </div>
            )}
          </div>
          <div className="flex w-full flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {t('logoCrop.zoom')}
            </Label>
            {/* Logarithmic travel: on a linear slider from 0.15 to 4, "cover"
                would sit in the first fifth and every useful move would happen
                in a few pixels of track. */}
            <input
              type="range"
              min={Math.log(MIN_LOGO_ZOOM)}
              max={Math.log(MAX_LOGO_ZOOM)}
              step={0.001}
              value={Math.log(crop.zoom)}
              disabled={!image || saving}
              aria-label={t('logoCrop.zoom')}
              onChange={(e) => {
                const zoom = Math.exp(Number(e.target.value));
                setCrop((c) => (size ? normalizeCrop(size, { ...c, zoom }) : { ...c, zoom }));
              }}
              className="w-full accent-foreground"
            />
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] leading-tight text-muted-foreground">
                {t('logoCrop.dragHint')}
              </p>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  disabled={!image || saving}
                  onClick={() =>
                    size && setCrop((c) => normalizeCrop(size, { ...c, zoom: containZoom(size) * 0.92, offsetX: 0, offsetY: 0 }))
                  }
                >
                  {t('logoCrop.fit')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px]"
                  disabled={!image || saving}
                  onClick={() =>
                    size && setCrop((c) => normalizeCrop(size, { ...c, ...DEFAULT_CROP, background: c.background }))
                  }
                >
                  {t('logoCrop.fill')}
                </Button>
              </div>
            </div>
          </div>
          <div className="flex w-full flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
              {t('logoCrop.background')}
            </Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={crop.background === null ? 'default' : 'outline'}
                disabled={saving}
                onClick={() => setCrop((c) => ({ ...c, background: null }))}
              >
                {t('logoCrop.transparent')}
              </Button>
              {suggestedBackground && (
                <Button
                  type="button"
                  size="sm"
                  variant={crop.background === suggestedBackground ? 'default' : 'outline'}
                  disabled={saving}
                  onClick={() => setCrop((c) => ({ ...c, background: suggestedBackground }))}
                >
                  <span
                    className="mr-1.5 size-3 rounded-full border border-border"
                    style={{ background: suggestedBackground }}
                  />
                  {t('logoCrop.projectColor')}
                </Button>
              )}
              <input
                type="color"
                value={crop.background ?? '#ffffff'}
                disabled={saving}
                aria-label={t('logoCrop.customBackground')}
                title={t('logoCrop.customBackground')}
                onChange={(e) => setCrop((c) => ({ ...c, background: e.target.value }))}
                className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={apply} disabled={!image || saving} className="gap-1.5">
            {saving && <Loader2 className="size-3.5 animate-spin" />}
            {saving ? t('logoCrop.uploading') : t('logoCrop.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
