'use client';

/**
 * The picture the main agent asked for, as a card in its own conversation
 * (`setup_request_avatar`). The user picks a file, frames it in the shared
 * dialog, or says "not now"; either way the answer goes back to the agent,
 * which reacts in its next message. Answered, the card keeps its final state.
 */
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Check, ImagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoCropDialog, type LogoCropSource } from '@/components/logo-crop-dialog';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import { t } from '@/lib/i18n';

export type SetupAvatarRequest = { id: string; state: 'pending' | 'set' | 'skipped' };

async function answer(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/ui/setup/main-agent/avatar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function SetupAvatarCard({ request, avatar }: { request: SetupAvatarRequest; avatar?: ReactNode }): ReactElement {
  const picker = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<LogoCropSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = request.state === 'pending';

  const pick = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) { setError(t('setupChat.avatar.tooLarge')); return; }
    setError(null);
    setSource(file);
  };

  return (
    <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[34px_minmax(0,1fr)_34px]" data-setup-avatar={request.state}>
      {avatar ?? <span aria-hidden />}
      <div className="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 shadow-elev-1">
        <p className="text-[13px] font-medium">{t('setupChat.avatar.title')}</p>
        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={picker}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }}
            />
            <Button size="sm" className="h-8 gap-1.5" disabled={busy} onClick={() => picker.current?.click()}>
              <ImagePlus className="size-3.5" aria-hidden />
              {t('setupChat.avatar.pick')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void answer({ id: request.id, skipped: true }).then((ok) => {
                  setBusy(false);
                  if (!ok) setError(t('setupChat.avatar.failed'));
                });
              }}
            >
              {t('setupChat.avatar.later')}
            </Button>
          </div>
        ) : (
          <span className="flex w-fit items-center gap-1 rounded px-2 py-0.5 text-[11px] bg-muted text-muted-foreground">
            {request.state === 'set' && <Check className="size-3" aria-hidden />}
            {t(request.state === 'set' ? 'setupChat.avatar.set' : 'setupChat.avatar.skipped')}
          </span>
        )}
        {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      </div>
      <LogoCropDialog
        source={source}
        endpoint="/api/uploads/projects"
        onCancel={() => setSource(null)}
        onUploaded={(url) => {
          setSource(null);
          setBusy(true);
          void answer({ id: request.id, avatarUrl: url }).then((ok) => {
            setBusy(false);
            if (!ok) setError(t('setupChat.avatar.failed'));
          });
        }}
      />
    </div>
  );
}
