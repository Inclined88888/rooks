'use client';

/**
 * The logo control of every identity form: round preview, file browser, paste,
 * drop, emoji, and the framing dialog behind all of them.
 *
 * It exists because a project and an agent must offer the *same* settings —
 * the same zoom, the same background — and they used to each grow their own
 * half of them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Crop, ImagePlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { EmojiPicker } from '@/components/emoji-picker';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import { isIconUrl } from '@/lib/project-visual';
import { accentVars } from '@/lib/accent-color';

/** Longest text logo the daemon keeps (`PROJECT_ICON_TEXT_MAX`, projects.ts). */
const PROJECT_ICON_TEXT_MAX = 32;

/** First image found in a paste or a drop. */
export function firstImageFile(
  items: DataTransferItemList | null,
  files: FileList | null,
): File | null {
  if (items) {
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
  }
  if (files) {
    for (const f of Array.from(files)) {
      if (f.type.startsWith('image/')) return f;
    }
  }
  return null;
}

export type LogoFieldProps = {
  /** Emoji or short text, a picture the daemon serves, or empty. */
  value: string;
  onChange: (value: string) => void;
  /** Accent colour of the owner — tints the preview and is offered as a
   *  background in the framing dialog. */
  accent: string;
  /** Drawn when there is no logo yet (initials, a letter). */
  fallback: string;
  /** Upload endpoint. Projects and agents share the generic image store. */
  endpoint?: string;
  disabled?: boolean;
  /** Shows the raw value field, for a short code an emoji picker cannot give.
   *  An image only comes from an upload: the daemon refuses a web address. */
  withValueInput?: boolean;
  /** Side of the preview circle, in CSS pixels. */
  size?: number;
};

export function LogoField({
  value,
  onChange,
  accent,
  fallback,
  endpoint = '/api/uploads/projects',
  disabled,
  withValueInput = true,
  size = 88,
}: LogoFieldProps) {
  const [source, setSource] = useState<LogoCropSource | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasImage = isIconUrl(value);

  const accept = useCallback((file: File | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('projectsPage.imageOnly'));
      return;
    }
    // Every image goes through the framing dialog: it is the only place where
    // a square logo becomes something worth putting in a circle.
    setSource(file);
  }, []);

  // Ctrl/Cmd+V anywhere in the form pastes into the logo — the shortcut users
  // already had before there was a button to click.
  useEffect(() => {
    if (disabled) return;
    const onPaste = (e: ClipboardEvent) => {
      const img = firstImageFile(e.clipboardData?.items ?? null, null);
      if (!img) return;
      e.preventDefault();
      accept(img);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [accept, disabled]);

  return (
    <div
      className={`flex flex-col items-center gap-2 rounded-md border border-dashed p-2 transition-colors ${
        dragOver ? 'border-foreground/50 bg-muted/60' : 'border-transparent'
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        accept(firstImageFile(e.dataTransfer?.items ?? null, e.dataTransfer?.files ?? null));
      }}
    >
      <button
        type="button"
        disabled={disabled}
        title={t('projectsPage.chooseImage')}
        aria-label={t('projectsPage.chooseImage')}
        onClick={() => fileInputRef.current?.click()}
        style={{ ...accentVars(accent), width: size, height: size }}
        className="grid shrink-0 place-items-center overflow-hidden rounded-full border border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)] transition-opacity hover:opacity-80 dark:border-[var(--accent-border-dark)] dark:bg-[var(--accent-soft-dark)] dark:text-[var(--accent-dark)]"
      >
        {hasImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="size-full object-cover" />
        ) : value ? (
          <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>{value}</span>
        ) : (
          <span style={{ fontSize: size * 0.3 }} className="font-semibold">
            {fallback}
          </span>
        )}
      </button>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <ImagePlus className="size-3.5" />
          {t('projectsPage.chooseImage')}
        </Button>
        <EmojiPicker disabled={disabled} onPick={onChange} />
        {hasImage && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={disabled}
            title={t('logoCrop.adjust')}
            onClick={() => setSource(value)}
          >
            <Crop className="size-3.5" />
            {t('logoCrop.adjust')}
          </Button>
        )}
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="px-2"
            disabled={disabled}
            title={t('projectsPage.clearLogo')}
            aria-label={t('projectsPage.clearLogo')}
            onClick={() => onChange('')}
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
      {withValueInput && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('projectsPage.logoPlaceholder')}
          maxLength={hasImage ? undefined : PROJECT_ICON_TEXT_MAX}
          disabled={disabled}
          className="h-8 text-center text-xs"
        />
      )}
      <p className="text-center text-[10px] leading-tight text-muted-foreground">
        {t('projectsPage.logoHint')}
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // The input keeps its last value: without a reset, picking the same
          // file twice in a row fires nothing.
          e.target.value = '';
          accept(file);
        }}
      />
      <LogoCropDialog
        source={source}
        endpoint={endpoint}
        suggestedBackground={accent}
        onCancel={() => setSource(null)}
        onUploaded={(url) => {
          setSource(null);
          onChange(url);
        }}
      />
    </div>
  );
}
