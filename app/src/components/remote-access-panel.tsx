'use client';

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { t } from '@/lib/i18n';
import { remoteAccessCommands, type AppListener } from '@/lib/remote-access';
import { CommandToRun } from '@/components/command-to-run';

/**
 * Reaching this instance from elsewhere — explanatory only, and folded away.
 *
 * It sits on the LAST step of the wizard because that is the moment the
 * question arises, and it is collapsed because it is the one thing there that
 * is NOT a step: nothing here blocks anything. Listener information is read
 * only while expanded; unavailable information never blocks setup.
 *
 * Its own component since the confirmation dialog it used to live in was
 * replaced by `/setup/restart` (step 5).
 */
export function RemoteAccess() {
  const [open, setOpen] = useState(false);
  const [app, setApp] = useState<Partial<AppListener> | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/ui/webui-access', { cache: 'no-store', signal: controller.signal });
        const report = response.ok ? (await response.json() as { app?: Partial<AppListener> } | null) : null;
        if (!controller.signal.aborted && report && typeof report === 'object' && report.app) {
          setApp(report.app);
        }
      } catch {
        // Setup remains usable when the diagnostic route cannot be read.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [open]);
  const commands = remoteAccessCommands(app);
  return (
    <div className="rounded-md border p-3">
      <button
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium"
        aria-expanded={open}
        onClick={() => {
          setApp(null);
          setLoading(true);
          setOpen((previous) => !previous);
        }}
        type="button"
      >
        <span>{t('setupPage.remoteAccess')}</span>
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {/* Rendered, not hidden: the panel must not weigh on a dialog nobody
          opened it from, and its absence is what the render test checks. */}
      {open && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">{t('setupPage.remoteAccessIntro')}</p>
          <section className="space-y-1">
            <h3 className="text-xs font-medium">{t('setupPage.remoteAccessAppTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('setupPage.remoteAccessAppHint')}</p>
            <a
              className="text-xs underline"
              href="https://tailscale.com/download"
              rel="noreferrer noopener"
              target="_blank"
            >
              {t('setupPage.remoteAccessDownload')}
            </a>
          </section>
          <section className="space-y-1">
            <h3 className="text-xs font-medium">{t('setupPage.remoteAccessCliTitle')}</h3>
            <p className="text-xs text-muted-foreground">{t('setupPage.remoteAccessCliHint')}</p>
            <CommandToRun command={commands.up} label={t('setupPage.remoteAccessCommandLabel')} />
            {commands.serve ? (
              <CommandToRun command={commands.serve} label={t('setupPage.remoteAccessCommandLabel')} />
            ) : (
              <p className="text-xs text-muted-foreground" role="status">
                {t(loading ? 'setupPage.remoteAccessTargetLoading' : 'setupPage.remoteAccessTargetUnknown')}
              </p>
            )}
            {commands.serve && <p className="text-xs text-muted-foreground">{t('setupPage.remoteAccessConsoleHint')}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
