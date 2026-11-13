'use client';

/**
 * The "new version" banner (docs/AUTO-UPDATE.md §6, P1b): the host, mounted
 * at the top of the page beside the licence banners, and the product's
 * banner, the default occupant of `updates.banner`.
 *
 * In a browser it links to the installer. In the desktop app the shell
 * downloads and verifies it (P2), then installs it the system's way (P3):
 * running missions are counted first, and "Wait" / "Install anyway"
 * asked when some would stop. The notes are the daemon's plain text, shown
 * as text.
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { UPDATES_BANNER_SLOT } from '@/lib/plugin-host/slots';
import {
  clientOs, installersFor, remindLater, useUpdateStore, visibleOffer, watchUpdateStatus,
  type UpdateArtifact, type UpdateOffer, type UpdateStatus,
} from '@/lib/updates';
import { formatBytes, formatDate, formatPercent } from '@/lib/intl';
import {
  useUpdateDownload, type UpdateDownloadControl, type UpdateDownloadErrorCode, type UpdateInstallOutcome,
} from '@/lib/update-download';
import { copyToClipboard } from '@/lib/clipboard';
import { t } from '@/lib/i18n';
import { UpdateStatusProvider, useUpdateStatus, type UpdateStatusValue } from './update-status-context';

/** Product names of the formats: never translated. */
const FORMAT_LABEL: Record<UpdateArtifact['format'], string> = {
  appimage: 'AppImage',
  deb: '.deb',
  pkg: '.pkg',
  dmg: '.dmg',
  nsis: '.exe',
};

function downloadLabel(artifact: UpdateArtifact): string {
  const format = FORMAT_LABEL[artifact.format];
  if (artifact.os === 'mac') return t('updates.banner.downloadMac', { format });
  if (artifact.os === 'win') return t('updates.banner.downloadWindows', { format });
  return t('updates.banner.downloadLinux', { format });
}

function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatDate(date, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

const linkClass = 'underline underline-offset-2 hover:opacity-80';

const DOWNLOAD_ERROR: Record<UpdateDownloadErrorCode, string> = {
  no_offer: 'updates.download.error.noOffer',
  daemon: 'updates.download.error.daemon',
  network: 'updates.download.error.network',
  http: 'updates.download.error.http',
  insecure_redirect: 'updates.download.error.insecure',
  too_many_redirects: 'updates.download.error.insecure',
  size: 'updates.download.error.integrity',
  integrity: 'updates.download.error.integrity',
  disk_full: 'updates.download.error.diskFull',
  filesystem: 'updates.download.error.filesystem',
};

/** What the banner says after "Install" (P3); `null` while nothing was asked. */
function InstallResult({ outcome, control, onWait, onConfirm, onDownloadAgain }: {
  outcome: UpdateInstallOutcome;
  control: UpdateDownloadControl;
  onWait: () => void;
  onConfirm: () => void;
  onDownloadAgain: () => void;
}): ReactElement | null {
  const [copied, setCopied] = useState(false);
  switch (outcome.status) {
    case 'missions':
      return (
        <>
          <span role="alert" data-update-missions={outcome.count}>{t('updates.download.missions', { count: outcome.count })}</span>
          <button type="button" className={linkClass} onClick={onWait} data-update-wait="">{t('updates.download.wait')}</button>
          <button type="button" className={`${linkClass} font-semibold`} onClick={onConfirm} data-update-install-anyway="">
            {t('updates.download.installAnyway')}
          </button>
        </>
      );
    case 'restarting':
      return <span data-update-installed="restarting">{t('updates.download.restarting')}</span>;
    case 'closing':
      return <span data-update-installed="closing">{t('updates.download.closing')}</span>;
    case 'opened':
      return <span data-update-installed="opened">{t('updates.download.pkgOpened')}</span>;
    case 'guided':
      return (
        <>
          <span data-update-installed="guided">{t(outcome.opened ? 'updates.download.debGuided' : 'updates.download.debNotOpened')}</span>
          {/* code-font: a command to paste in a terminal */}
          <code className="select-all rounded bg-background/15 px-1.5 py-0.5 font-mono" data-update-command="">{outcome.command}</code>
          <button
            type="button"
            className={linkClass}
            onClick={() => { void copyToClipboard(outcome.command).then(setCopied); }}
            data-update-copy=""
          >
            {copied ? t('updates.download.copied') : t('updates.download.copyCommand')}
          </button>
        </>
      );
    case 'not_writable':
      return (
        <>
          <span role="alert" data-update-installed="not_writable">{t('updates.download.notWritable')}</span>
          <button type="button" className={linkClass} onClick={() => { void control.openFolder(); }} data-update-open-folder="">
            {t('updates.download.openFolder')}
          </button>
        </>
      );
    case 'none':
      // The shell has no verified file any more (removed from the data folder, a download reset): fetch it again.
      return (
        <>
          <span role="alert" data-update-installed="none">{t('updates.download.installNone')}</span>
          <button type="button" className={`${linkClass} font-semibold`} onClick={onDownloadAgain} data-update-redownload="">
            {t('updates.download.downloadAgain')}
          </button>
        </>
      );
    case 'unsupported':
      return null;
    case 'failed':
      return <span role="alert" data-update-installed="failed">{t('updates.download.installFailed')}</span>;
    default: {
      // A new outcome must get its own words here, never fall into "failed".
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** The desktop app's own download: progress, cancel, then the verified file and its installation. */
function DesktopDownload({ control }: { control: UpdateDownloadControl }): ReactElement {
  const { state } = control;
  const [openFailed, setOpenFailed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [outcome, setOutcome] = useState<UpdateInstallOutcome | null>(null);
  const readyVersion = state.phase === 'ready' ? `${state.version}/${state.name}` : null;
  // A new file (another version, a new download) starts from "Install" again.
  useEffect(() => { setOutcome(null); }, [readyVersion]);
  const open = (gesture: () => Promise<{ status: string }>): void => {
    setOpenFailed(false);
    void gesture().then((result) => { setOpenFailed(result.status !== 'opened'); });
  };
  const install = (confirmed: boolean): void => {
    setInstalling(true);
    setOpenFailed(false);
    void control.install(confirmed).then((result) => {
      setInstalling(false);
      // A desktop older than the installation step: open the installer as before.
      if (result.status === 'unsupported') { setOutcome(null); open(control.openInstaller); return; }
      setOutcome(result);
    });
  };
  // The verdict on the vanished file goes with it, even if the shell answers "ready" for the same name at once.
  const downloadAgain = (): void => { setOutcome(null); control.start(); };
  if (state.phase === 'downloading') {
    return (
      <>
        <span className="tabular-nums" data-update-progress="">
          {t('updates.download.progress', {
            percent: formatPercent(state.total > 0 ? state.received / state.total : 0),
            received: formatBytes(state.received),
            total: formatBytes(state.total),
          })}
        </span>
        <button type="button" className={linkClass} onClick={control.cancel} data-update-cancel="">{t('updates.download.cancel')}</button>
      </>
    );
  }
  if (state.phase === 'verifying') return <span data-update-progress="">{t('updates.download.verifying')}</span>;
  if (state.phase === 'ready') {
    // Without a verified file (`none`), "Install" and "Show in folder" have nothing left to act on.
    if (outcome && outcome.status !== 'unsupported' && outcome.status !== 'failed') {
      return <InstallResult outcome={outcome} control={control} onWait={() => { setOutcome(null); }} onConfirm={() => { install(true); }} onDownloadAgain={downloadAgain} />;
    }
    return (
      <>
        <span>{t('updates.download.ready', { name: state.name })}</span>
        <button type="button" className={`${linkClass} font-semibold`} disabled={installing} onClick={() => { install(false); }} data-update-install="">
          {state.format === 'appimage' ? t('updates.download.installRestart') : t('updates.download.install')}
        </button>
        <button type="button" className={linkClass} onClick={() => { open(control.openFolder); }} data-update-open-folder="">
          {t('updates.download.openFolder')}
        </button>
        {outcome && <InstallResult outcome={outcome} control={control} onWait={() => { setOutcome(null); }} onConfirm={() => { install(true); }} onDownloadAgain={downloadAgain} />}
        {openFailed && <span role="alert">{t('updates.download.openFailed')}</span>}
      </>
    );
  }
  if (state.phase === 'failed') {
    return (
      <>
        <span role="alert" data-update-error={state.code}>{t(DOWNLOAD_ERROR[state.code])}</span>
        <button type="button" className={`${linkClass} font-semibold`} onClick={control.start} data-update-start="">
          {state.resumable ? t('updates.download.resume') : t('updates.download.retry')}
        </button>
      </>
    );
  }
  return (
    <button type="button" className={`${linkClass} font-semibold`} onClick={control.start} data-update-start="">
      {t('updates.download.start')}
    </button>
  );
}

/**
 * The product's banner: the default occupant of `updates.banner`. `null`
 * outside the host. `dismissible={false}` drops "Later": on the lock screen of
 * an ended build the offer is the only way out, so it cannot be put off.
 */
export function ProductUpdateBanner({ dismissible = true }: { dismissible?: boolean }): ReactElement | null {
  const update = useUpdateStatus();
  const [notesOpen, setNotesOpen] = useState(false);
  if (!update) return null;
  const { offer, installers } = update;
  const [primary, ...others] = installers;
  const ends = shortDate(update.buildExpiresAt);
  return (
    <div role="status" data-update-banner={offer.version} className="shrink-0 bg-primary px-3 py-1.5 text-xs text-primary-foreground">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <span className="font-semibold">
          {t('updates.banner.available', { version: offer.version, installed: update.installed })}
        </span>
        {ends && <span>{t('updates.banner.buildEnds', { date: ends })}</span>}
        {update.download ? (
          <DesktopDownload control={update.download} />
        ) : primary ? (
          <a className={`${linkClass} font-semibold`} href={primary.url} target="_blank" rel="noopener noreferrer" data-update-download={primary.key}>
            {downloadLabel(primary)}
          </a>
        ) : (
          <a className={`${linkClass} font-semibold`} href={offer.notesUrl} target="_blank" rel="noopener noreferrer">
            {t('updates.banner.downloadPage')}
          </a>
        )}
        {others.map((artifact) => (
          <a key={artifact.key} className={linkClass} href={artifact.url} target="_blank" rel="noopener noreferrer" data-update-download={artifact.key}>
            {FORMAT_LABEL[artifact.format]}
          </a>
        ))}
        <button type="button" className={linkClass} aria-expanded={notesOpen} onClick={() => { setNotesOpen((open) => !open); }}>
          {notesOpen ? t('updates.banner.hideNotes') : t('updates.banner.notes')}
        </button>
        {dismissible && (
          <button type="button" className={linkClass} onClick={update.later} data-update-later="">
            {t('updates.banner.later')}
          </button>
        )}
      </div>
      {notesOpen && (
        <div className="mx-auto mt-1.5 max-h-56 max-w-3xl overflow-auto rounded-md bg-background/15 p-2 text-left">
          <p className="m-0 whitespace-pre-wrap" data-update-notes="">{offer.notes.trim() || t('updates.banner.noNotes')}</p>
          <a className={`${linkClass} mt-1 inline-block`} href={offer.notesUrl} target="_blank" rel="noopener noreferrer">
            {t('updates.banner.fullNotes')}
          </a>
        </div>
      )}
    </div>
  );
}

/** What the banner is painted for, or `null` when there is nothing to offer (no offer, a source build). */
function bannerValue(status: UpdateStatus | null, offer: UpdateOffer | null, download: UpdateDownloadControl | null): UpdateStatusValue | null {
  if (!offer || !status || status.channel === 'dev') return null;
  const os = typeof navigator === 'undefined' ? null : clientOs(navigator.userAgent);
  return {
    installed: status.installed,
    channel: status.channel,
    offer,
    installers: installersFor(offer, os, status.host),
    buildExpiresAt: status.buildExpiresAt,
    later: () => { remindLater(offer.version); },
    download,
  };
}

/**
 * Mounted once in the top bar, above the nav. Paints the occupant of
 * `updates.banner` — or the product's banner while the slot is empty (a page
 * outside the bundled halves) — only while a newer version is offered and not
 * put off.
 */
export function UpdateBannerHost(): ReactElement | null {
  const store = useUpdateStore();
  const offer = visibleOffer(store);
  const status = store.status;
  const claimed = useSlotEntries(UPDATES_BANNER_SLOT).length > 0;
  const download = useUpdateDownload(offer?.version ?? null);
  const value = useMemo(() => bannerValue(status, offer, download), [download, offer, status]);
  if (!value) return null;
  return (
    <UpdateStatusProvider value={value}>
      {claimed ? <SlotSingle name={UPDATES_BANNER_SLOT} /> : <ProductUpdateBanner />}
    </UpdateStatusProvider>
  );
}

/**
 * The offer on the lock screen of a beta build that can no longer run
 * (docs/AUTO-UPDATE.md §4): the newer version is the way out, so "Later" is
 * neither shown nor honoured. No store and no event stream — the daemon walls
 * the stream while locked, and nothing else on that screen is mounted,
 * `updates.banner` included: the product's banner paints. Without the stream
 * the screen reads the status again while the daemon has not settled it: a
 * screen opened right after a restart comes before the daemon's first check.
 */
// `retryMs` defaults to `UPDATE_STATUS_RETRY_MS`; only tests shorten it.
export function LockScreenUpdateOffer({ retryMs }: { retryMs?: number }): ReactElement | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => watchUpdateStatus(setStatus, { intervalMs: retryMs }), [retryMs]);
  const offer = status?.state === 'available' ? status.available : null;
  const download = useUpdateDownload(offer?.version ?? null);
  const value = useMemo(() => {
    const found = bannerValue(status, offer, download);
    // The screen above already says when and why the build stopped.
    return found && { ...found, buildExpiresAt: null };
  }, [download, offer, status]);
  if (!value) return null;
  return (
    <div className="overflow-hidden rounded-xl" data-lock-update-offer="">
      <UpdateStatusProvider value={value}>
        <ProductUpdateBanner dismissible={false} />
      </UpdateStatusProvider>
    </div>
  );
}
