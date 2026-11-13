'use client';

/**
 * Settings › AI models › CLI binaries (TODO #413): where each backend CLI was
 * found, and a path to pin when it was not. Saving applies at once — the
 * daemon writes `host.binaries` and its next mission uses the new path, no
 * restart. "Check again" re-reads the configuration file and looks for the
 * CLIs again, for whoever just installed one or edited the file by hand.
 *
 * Superadmin signed in to the app only, and the daemon is what enforces it:
 * this panel renders nothing when the list is refused. The path shown as
 * resolved is always the daemon's, never the text typed here.
 *
 * "Browse…" opens this computer's dialog only when the active daemon runs
 * here, in the desktop app; otherwise (another machine, a web browser) the
 * daemon's own file browser (`directory.picker` in file mode, TODO #791).
 */
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { reportDirectoryPick, useDirectoryPicker } from '@/components/directory-browser';
import {
  binaryState, fetchBinaries, pinBinary, recheckBinaries, unpinBinary, type BackendBinary, type BinaryState,
} from '@/lib/backend-binaries';
import { desktopBridge } from '@/lib/desktop';
import { nativePickerReachesDaemon, type DirectoryPick } from '@/lib/directory-pick';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { t } from '@/lib/i18n';

const STATE_TONE: Record<BinaryState, string> = {
  found: 'text-emerald-700 dark:text-emerald-300',
  pinned: 'text-emerald-700 dark:text-emerald-300',
  brokenPin: 'text-destructive',
  missing: 'text-amber-700 dark:text-amber-300',
};

export function BinariesPanel(): ReactElement | null {
  const [binaries, setBinaries] = useState<BackendBinary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nativeBrowse, setNativeBrowse] = useState(false);
  const { pickFile, dialog } = useDirectoryPicker();

  useEffect(() => {
    // The pin is checked and run by the active machine's daemon: this
    // computer's dialog only when that daemon is here (TIM-0136).
    setNativeBrowse(typeof desktopBridge()?.selectExecutable === 'function' && nativePickerReachesDaemon(activeMachineId()));
    // Refused (not a superadmin) or an older daemon: nothing to offer.
    void fetchBinaries().then(setBinaries, () => setBinaries(null));
  }, []);

  const recheck = useCallback(async () => {
    setBusy('recheck');
    try {
      const out = await recheckBinaries();
      setBinaries(out.binaries);
      if (out.configError) toast.error(t(`binariesSettings.errors.${out.configError}`));
      else toast.success(t('binariesSettings.rechecked'));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  if (binaries === null) return null;

  return (
    <section className="mt-8 max-w-3xl space-y-3" aria-labelledby="binaries-title">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="binaries-title" className="m-0 text-sm font-semibold">{t('binariesSettings.title')}</h3>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1.5 px-2 text-xs" disabled={busy !== null} onClick={() => void recheck()}>
          <RefreshCw className={`h-3.5 w-3.5${busy === 'recheck' ? ' animate-spin' : ''}`} aria-hidden />
          {t('binariesSettings.recheck')}
        </Button>
      </div>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('binariesSettings.description')}</p>
      {binaries.length === 0
        ? <p className="m-0 text-xs text-muted-foreground">{t('binariesSettings.none')}</p>
        : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {binaries.map((binary) => (
              <BinaryRow
                key={binary.cmd}
                binary={binary}
                nativeBrowse={nativeBrowse}
                pickFile={pickFile}
                disabled={busy !== null}
                onBusy={(on) => setBusy(on ? binary.cmd : null)}
                onChanged={setBinaries}
              />
            ))}
          </ul>
        )}
      {dialog}
    </section>
  );
}

function BinaryRow({
  binary, nativeBrowse, pickFile, disabled, onBusy, onChanged,
}: {
  binary: BackendBinary;
  nativeBrowse: boolean;
  pickFile: (current: string) => Promise<DirectoryPick>;
  disabled: boolean;
  onBusy: (on: boolean) => void;
  onChanged: (next: BackendBinary[]) => void;
}): ReactElement {
  const [draft, setDraft] = useState(binary.pin ?? '');
  const [error, setError] = useState<string | null>(null);
  const state = binaryState(binary);
  const inputId = `binary-path-${binary.cmd}`;

  // A save, a removal or a recheck replaces the row's data: the field follows.
  useEffect(() => { setDraft(binary.pin ?? ''); }, [binary.pin]);

  const work = async (action: () => Promise<BackendBinary[]>, success: string): Promise<void> => {
    setError(null);
    onBusy(true);
    try {
      onChanged(await action());
      toast.success(success);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      onBusy(false);
    }
  };

  const browse = async (): Promise<void> => {
    const current = draft.trim() || binary.path || '';
    const picker = nativeBrowse ? desktopBridge()?.selectExecutable : undefined;
    if (!picker) {
      // Any file: a CLI is `claude`, `claude.cmd` or `claude.exe` depending on the OS.
      const pick = await pickFile(current);
      if (pick.status === 'chosen') { setDraft(pick.path); setError(null); } else reportDirectoryPick(pick);
      return;
    }
    try {
      const picked = await picker(current || undefined);
      if (picked) { setDraft(picked); setError(null); }
    } catch {
      setError(t('binariesSettings.errors.browse'));
    }
  };

  const trimmed = draft.trim();
  const unchanged = trimmed === (binary.pin ?? '');

  return (
    <li className="space-y-2 rounded-md bg-muted/30 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[13px] font-medium">{binary.cmd}</span>
        <span className="text-[11px] text-muted-foreground">{t('binariesSettings.backends', { list: binary.backends.join(', ') })}</span>
        <span className={`ml-auto text-xs ${STATE_TONE[state]}`}>{t(`binariesSettings.state.${state}`)}</span>
      </div>
      <p className="m-0 break-all text-xs text-muted-foreground">
        {binary.path
          ? t('binariesSettings.resolved', { path: binary.path })
          : state === 'brokenPin' && binary.pin
            ? t('binariesSettings.brokenPin', { path: binary.pin })
            : t('binariesSettings.notFound')}
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || unchanged) return;
          void work(() => pinBinary(binary.cmd, trimmed), t('binariesSettings.saved', { name: binary.cmd }));
        }}
      >
        <label htmlFor={inputId} className="sr-only">{t('binariesSettings.pathLabel', { name: binary.cmd })}</label>
        <Input
          id={inputId}
          className="h-8 min-w-[16rem] flex-1 text-xs"
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('binariesSettings.placeholder')}
          disabled={disabled}
          aria-invalid={error !== null}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => { setDraft(event.target.value); setError(null); }}
        />
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5 text-xs" disabled={disabled} onClick={() => void browse()}>
          <FolderOpen className="h-3.5 w-3.5" aria-hidden />
          {t('binariesSettings.browse')}
        </Button>
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={disabled || !trimmed || unchanged}>
          {t('binariesSettings.save')}
        </Button>
        {binary.pin !== null && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            disabled={disabled}
            onClick={() => void work(() => unpinBinary(binary.cmd), t('binariesSettings.cleared', { name: binary.cmd }))}
          >
            {t('binariesSettings.clear')}
          </Button>
        )}
      </form>
      {error && <p id={`${inputId}-error`} className="m-0 text-xs text-destructive" role="alert">{error}</p>}
    </li>
  );
}
