'use client';

import { useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import Link from 'next/link';
import { desktopBridge } from '@/lib/desktop';
import { useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';

/** Read the shell's live state so navigation/reloads cannot lose a deferred restart. */
export function SetupRestartBanner() {
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const restarting = useRef(false);
  // Without the desktop shell (a browser on the daemon), the daemon says it
  // still runs on the configuration it replaced: the restart page does the rest.
  const caps = useCapabilities();
  const [hasBridge, setHasBridge] = useState(true);
  useEffect(() => { setHasBridge(Boolean(desktopBridge()?.setupRestartPending)); }, []);

  useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge?.setupRestartPending) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const required = await bridge.setupRestartPending!();
        if (!disposed && !restarting.current) setPending(required);
      } catch { /* Keep the last known state while the shell is unavailable. */ }
      finally { if (!disposed) timer = setTimeout(refresh, 3000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  async function restart() {
    const bridge = desktopBridge();
    if (!bridge || restarting.current) return;
    restarting.current = true;
    setBusy(true);
    setFailed(false);
    try { await bridge.restartAfterSetup(); }
    catch {
      restarting.current = false;
      setBusy(false);
      setFailed(true);
    }
  }

  if (!hasBridge && caps?.restartOnboarding === true) {
    return (
      <div className="bg-[#111111] px-4 py-3 text-white">
        <div className="flex items-center gap-6">
          <p role="status" className="min-w-0 flex-1 text-sm leading-relaxed">{t('setupPage.restartWebHint')}</p>
          <Link prefetch={false} href="/setup/restart"
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/40 px-3 py-2 text-sm font-medium no-underline transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            <RotateCw className="size-4" aria-hidden="true" />
            {t('setupPage.restartWebNow')}
          </Link>
        </div>
      </div>
    );
  }
  if (!pending) return null;
  return (
    <div className="bg-[#111111] px-4 py-3 text-white" aria-busy={busy}>
      <div className="flex items-center gap-6">
        <p role="status" className="min-w-0 flex-1 text-sm leading-relaxed">{t('setupPage.restartDesktopHint')}</p>
        <button type="button" onClick={() => void restart()} disabled={busy}
          className="inline-flex shrink-0 items-center gap-2 rounded-md border border-white/40 px-3 py-2 text-sm font-medium transition-colors hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-wait disabled:opacity-60">
          <RotateCw className="size-4" aria-hidden="true" />
          {t(busy ? 'setupPage.restarting' : 'setupPage.restartNow')}
        </button>
      </div>
      {failed && <p role="alert" className="mt-2 max-w-prose text-sm text-white">{t('setupPage.restartFailed')}</p>}
    </div>
  );
}
