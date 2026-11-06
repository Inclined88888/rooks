'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Trash2, X } from 'lucide-react';
import { nativeBrowserRequest, type BrowserCommand } from '@/lib/native-browser';
import { t } from '@/lib/i18n';

type Credential = { id: string; profileId: string; origin: string; label: string; usernameHint: string; createdAt: string; updatedAt: string };
const inputClass = 'w-full rounded border border-input bg-background px-2 py-1.5 text-xs';
const actionClass = 'rounded border border-border px-2 py-1.5 text-xs hover:bg-muted disabled:opacity-40';
export function credentialOrigin(url: string): string { try { const value = new URL(url); return /^https?:$/.test(value.protocol) ? value.origin : ''; } catch { return ''; } }

export function BrowserCredentials({ profileId, url, controlled, command, close }: { profileId: string; url: string; controlled: boolean; command: BrowserCommand; close: () => void }) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const currentOrigin = credentialOrigin(url);
  const [origin, setOrigin] = useState(currentOrigin);
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [revision, setRevision] = useState(0);
  const base = `${encodeURIComponent(profileId)}/credentials`;
  useEffect(() => {
    const controller = new AbortController();
    void nativeBrowserRequest<{ credentials: Credential[] }>(base, undefined, controller.signal).then((result) => setCredentials(result.credentials)).catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [base, revision]);
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await operation(); setRevision((value) => value + 1); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.credentials')} className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-card p-3">
    <div className="mb-3 flex items-center gap-2"><KeyRound className="size-4" /><h2 className="min-w-0 flex-1 text-sm font-medium">{t('browserPanel.native.credentials')}</h2><button type="button" className={actionClass} aria-label={t('browserPanel.native.close')} onClick={close}><X className="size-4" /></button></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
      <p className="text-xs text-muted-foreground">{t('browserPanel.native.credentialsHint')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {credentials.length === 0 && <p className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">{t('browserPanel.native.noCredentials')}</p>}
      {credentials.map((credential) => <div key={credential.id} className="space-y-1 rounded border border-border p-2">
        <p className="text-xs font-medium">{credential.label || credential.origin}</p><p className="break-all text-[11px] text-muted-foreground">{credential.origin} · {credential.usernameHint}</p>
        <div className="flex gap-2"><button type="button" className={actionClass} disabled={busy || !controlled || credential.origin !== currentOrigin} onClick={() => void act(() => command('fillCredential', { credentialId: credential.id }))}>{t('browserPanel.native.fillCredential')}</button>
          <button type="button" className={actionClass} disabled={busy} aria-label={t('browserPanel.native.deleteCredential')} onClick={() => void act(() => nativeBrowserRequest(`${base}/${encodeURIComponent(credential.id)}`, undefined, undefined, 'DELETE'))}><Trash2 className="size-3.5" /></button></div>
      </div>)}
      <button type="button" className={actionClass} disabled={!controlled || !currentOrigin || busy} onClick={() => void act(() => command('saveCredentialFromPage', { label: label.trim() || undefined }))}>{t('browserPanel.native.savePageCredential')}</button>
      <form className="space-y-2 rounded border border-border p-3" autoComplete="off" onSubmit={(event) => { event.preventDefault(); void act(async () => { await nativeBrowserRequest(base, { origin, label: label.trim(), username, password }); setPassword(''); setUsername(''); setLabel(''); }); }}>
        <h3 className="text-xs font-medium">{t('browserPanel.native.addCredential')}</h3>
        <label className="block space-y-1 text-xs">{t('browserPanel.native.origin')}<input required type="url" className={inputClass} value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://service.example" /></label>
        <label className="block space-y-1 text-xs">{t('browserPanel.native.credentialLabel')}<input className={inputClass} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
        <label className="block space-y-1 text-xs">{t('browserPanel.native.username')}<input required autoComplete="off" className={inputClass} value={username} onChange={(event) => setUsername(event.target.value)} /></label>
        <label className="block space-y-1 text-xs">{t('browserPanel.native.password')}<input required type="password" autoComplete="new-password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button type="submit" className={actionClass} disabled={busy || !password || !username || !credentialOrigin(origin)}>{t('browserPanel.native.save')}</button>
      </form>
    </div>
  </section>;
}
