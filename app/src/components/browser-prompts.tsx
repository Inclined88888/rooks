'use client';

import { useEffect, useRef, useState } from 'react';
import { uploadBrowserFiles } from '@/lib/native-browser-input';
import type { BrowserCommand, NativeBrowserStatus } from '@/lib/native-browser';
import { t } from '@/lib/i18n';

const button = 'rounded border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-40';
export function BrowserPrompts({ status, controlled, command }: { status: NativeBrowserStatus; controlled: boolean; command: BrowserCommand }) {
  const [promptText, setPromptText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const upload = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { setPromptText(status.dialog?.defaultPrompt ?? ''); setError(null); }, [status.dialog?.id, status.dialog?.defaultPrompt]);
  useEffect(() => { setProgress(null); return () => { upload.current?.abort(); }; }, [status.fileChooser?.id]);
  const act = async (action: string, data: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try { await command(action, data); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const permission = status.permissions?.[0];
  const dialog = status.dialog;
  const chooser = status.fileChooser;
  if (!dialog && !permission && !chooser) return null;
  return <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.pageRequest')} className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-3">
    <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-card p-4 shadow-xl">
      <h2 className="text-sm font-medium">{t('browserPanel.native.pageRequest')}</h2>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {!controlled && <p className="text-xs text-muted-foreground">{t('browserPanel.native.requestControlHint')}</p>}
      {dialog ? <>
        <p className="break-all text-[11px] text-muted-foreground">{dialog.url}</p><p className="whitespace-pre-wrap break-words text-sm">{dialog.message}</p>
        {dialog.type === 'prompt' && <input autoFocus value={promptText} disabled={!controlled} aria-label={t('browserPanel.native.dialogAnswer')} onChange={(event) => setPromptText(event.target.value)} className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm" />}
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={!controlled || busy} onClick={() => void act('dialogRespond', { dialogId: dialog.id, accept: false })}>{t('browserPanel.native.cancel')}</button><button type="button" className={button} disabled={!controlled || busy} onClick={() => void act('dialogRespond', { dialogId: dialog.id, accept: true, promptText })}>{t('browserPanel.native.accept')}</button></div>
      </> : permission ? <>
        <p className="break-all text-xs font-medium">{permission.origin}</p><p className="text-sm">{t('browserPanel.native.permissionRequest', { permission: permission.permission })}</p>
        {permission.hostDevices && <p className="rounded bg-muted p-2 text-xs">{t('browserPanel.native.hostDevices', { devices: permission.mediaTypes?.join(', ') || permission.permission })}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={button} disabled={!controlled || busy} onClick={() => void act('permissionRespond', { permissionId: permission.id, allow: false })}>{t('browserPanel.native.deny')}</button><button type="button" className={button} disabled={!controlled || busy} onClick={() => void act('permissionRespond', { permissionId: permission.id, allow: true })}>{t('browserPanel.native.allow')}</button></div>
      </> : chooser ? <>
        <p className="text-xs">{t('browserPanel.native.uploadHint')}</p>
        <input ref={fileInput} type="file" multiple={chooser.multiple} disabled={!controlled || busy} aria-label={t('browserPanel.native.chooseFiles')} className="w-full text-xs" onChange={(event) => {
          const files = Array.from(event.target.files ?? []); if (!files.length) return;
          const controller = new AbortController(); upload.current = controller; setBusy(true); setError(null);
          void uploadBrowserFiles(files, chooser.id, command, (done, total) => setProgress({ done, total }), controller.signal)
            .catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); })
            .finally(() => { setBusy(false); if (fileInput.current) fileInput.current.value = ''; });
        }} />
        {progress && <div><progress className="w-full" value={progress.done} max={Math.max(1, progress.total)} /><p className="text-[11px] text-muted-foreground">{Math.round(progress.done / Math.max(1, progress.total) * 100)}%</p></div>}
        <div className="flex justify-end"><button type="button" className={button} disabled={!controlled} onClick={() => { upload.current?.abort(); void act('fileUploadCancel', { chooserId: chooser.id }); }}>{t('browserPanel.native.cancel')}</button></div>
      </> : null}
    </div>
  </section>;
}
