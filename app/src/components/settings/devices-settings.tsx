'use client';

/**
 * Settings › Access & network › Devices: authorize a device with a one-time
 * pairing code, then see, rename and revoke the devices paired with the
 * signed-in account (multi-machine P2b). Core, not a Machines plugin pane: a
 * remote daemon must be able to authorize a device without that plugin.
 *
 * The other half of a pairing — entering a code another machine showed — is
 * the Machines plugin's (Settings → Plugins → Machines). This page points to
 * it, or says why it is not there, through the core: the add-form request
 * (`lib/machines/add-request.ts`) and the local module state, never the plugin.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { useCapabilities } from '@/lib/capabilities';
import { copyToClipboard } from '@/lib/clipboard';
import {
  cleanDeviceName, deviceErrorKind, DEVICE_NAME_MAX, formatCountdown, issuePairingCode, listDevices,
  makeMachineReachable, renameDevice, revokeDevice, secondsLeft, sortDevices,
  type DeviceFailure, type PairedDevice, type PairingCode, type ReachableFailure,
} from '@/lib/devices';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { requestAddMachine } from '@/lib/machines/add-request';
import { MACHINES_MODULE, machinesSettingsPath } from '@/lib/machines/fleet';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { machinesModuleHere, type MachinesHere } from '@/lib/machines/module-here';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { cn } from '@/lib/utils';
import { TAILSCALE_HTTPS_CONSOLE } from '@/lib/tailscale-setup';
import { pairingAddress } from '@/lib/webui-access';
import { TailscaleOperatorStep, TailscaleSetupFlow } from './tailscale-setup';

/** While a code is on screen, the list is re-read this often to catch the device that redeems it. */
const REDEEM_POLL_MS = 3000;

function errorMessage(failure: DeviceFailure): string {
  return t(`devicesSettings.errors.${deviceErrorKind(failure)}`);
}

function formatDate(ms: number): string {
  return formatDateTime(ms, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusChip({ device }: { device: PairedDevice }): ReactElement {
  const tone = device.status === 'active'
    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    : device.status === 'revoked' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground';
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px]', tone)}>{t(`devicesSettings.status.${device.status}`)}</span>;
}

/** Where the address to type next to the code is explained, when this machine cannot tell it. */
const PAIRING_DOCS_URL = `https://docs.${BRAND.domain}/usage/machines#add-a-machine`;

/** `undefined` while asked, `null` when this machine cannot tell (no tailnet handler, not an administrator). */
function usePairingAddress(): string | null | undefined {
  const [address, setAddress] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // Once per card, never with the redeem poll: the daemon runs `tailscale` to answer.
    void fetch('/api/ui/webui-access', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() as Promise<unknown> : null))
      .catch(() => null)
      .then((report) => { if (live) setAddress(pairingAddress(report)); });
    return () => { live = false; };
  }, []);
  return address;
}

/** What went wrong, what to run by hand on this machine, and where. */
function ReachableFailureNote({ failure }: { failure: ReachableFailure }): ReactElement {
  const copyCommand = async () => {
    if (failure.command && await copyToClipboard(failure.command)) toast.success(t('devicesSettings.reachable.commandCopied'));
  };
  return (
    <div role="alert" className="space-y-1.5 rounded-md bg-destructive/10 px-3 py-2">
      <p className="max-w-[65ch] text-[12px] leading-snug">{t(`devicesSettings.reachable.errors.${failure.reason}`)}</p>
      {failure.detail && <p className="break-all text-[11px] text-muted-foreground">{failure.detail}</p>}
      {failure.reason === 'serve_disabled' && (
        <>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('devicesSettings.reachable.enableHint')}</p>
          {/* tailscale's own link when it printed one, the console page that holds the switch otherwise */}
          <a href={failure.enableUrl ?? TAILSCALE_HTTPS_CONSOLE} target="_blank" rel="noopener noreferrer" className="text-[12px] text-foreground underline underline-offset-4">
            {t('devicesSettings.reachable.enable')}
          </a>
        </>
      )}
      {failure.command && (
        <>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t(failure.platform === 'win32' ? 'devicesSettings.reachable.runHintWindows' : 'devicesSettings.reachable.runHint')}
          </p>
          {/* code-font: a command line to copy */}
          <code className="block select-all break-all rounded-md bg-background px-2 py-1.5 font-mono text-[12px]">{failure.command}</code>
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => void copyCommand()}>
            {t('devicesSettings.reachable.copyCommand')}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * No address: offer to publish the daemon on the tailnet. Only to a
 * superadmin sitting at this machine — the daemon refuses anyone else, and a
 * button that can only fail is noise.
 */
function MakeReachable({ onAddress }: { onAddress: (address: string) => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReachableFailure | null>(null);
  // Publishing again on its own happens once: a second "not connected" after
  // Tailscale said it runs waits for a click instead of looping.
  const [autoUsed, setAutoUsed] = useState(false);
  const run = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    const outcome = await makeMachineReachable();
    setBusy(false);
    if (!outcome.ok) { setFailure(outcome); return; }
    toast.success(t('devicesSettings.reachable.done'));
    onAddress(outcome.address);
  }, [onAddress]);
  const continueAfterSetup = useCallback(() => {
    setAutoUsed(true);
    void run();
  }, [run]);
  const needsSetup = failure !== null && (failure.reason === 'not_installed' || failure.reason === 'not_connected');
  return (
    <div className="space-y-2">
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('devicesSettings.reachable.lead')}</p>
      {!needsSetup && (
        <Button type="button" size="sm" className="h-7 text-[12px]" disabled={busy} onClick={() => void run()}>
          {busy ? t('devicesSettings.reachable.busy') : t(failure ? 'devicesSettings.reachable.retry' : 'devicesSettings.reachable.action')}
        </Button>
      )}
      {needsSetup && <TailscaleSetupFlow autoContinue={!autoUsed} onReady={continueAfterSetup} />}
      {failure && !needsSetup && <ReachableFailureNote failure={failure} />}
      {failure?.reason === 'permission' && failure.platform === 'linux' && <TailscaleOperatorStep onDone={continueAfterSetup} />}
    </div>
  );
}

function PairingCodeCard({ code, onRenew, onDismiss, busy, canPublish }: {
  code: PairingCode;
  onRenew: () => void;
  onDismiss: () => void;
  busy: boolean;
  /** A superadmin on this very machine: the one person the daemon lets publish itself. */
  canPublish: boolean;
}): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  const left = secondsLeft(code.expiresAt, now);
  useEffect(() => {
    if (left === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [left]);

  const known = usePairingAddress();
  // Taken from the publish answer: no second `tailscale` round trip to learn what it just said.
  const [published, setPublished] = useState<string | null>(null);
  const address = published ?? known;

  const copy = async () => {
    if (await copyToClipboard(code.code)) toast.success(t('devicesSettings.copied'));
  };
  const copyAddress = async () => {
    if (address && await copyToClipboard(address)) toast.success(t('devicesSettings.addressCopied'));
  };

  return (
    <section aria-live="polite" className="space-y-2 rounded-md bg-muted/30 px-4 py-3">
      <h3 className="text-[13px] font-medium">{t('devicesSettings.codeTitle')}</h3>
      {left > 0 ? (
        <>
          {/* Read aloud or retyped by a person: the product font, tracked out, with stable digits. */}
          <p className="select-all text-2xl font-semibold tracking-[0.2em] tabular-nums">{code.code}</p>
          <p className="text-[12px] tabular-nums text-muted-foreground">
            {t('devicesSettings.expiresIn', { time: formatCountdown(left) })}
          </p>
          <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
            {t('devicesSettings.codeHint', { path: machinesSettingsPath() })}
          </p>
          {address && (
            <div className="space-y-0.5">
              <p className="text-[12px] text-muted-foreground">{t('devicesSettings.addressLabel')}</p>
              <p className="select-all break-all text-[13px] font-medium">{address}</p>
            </div>
          )}
          {address === null && (
            <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
              {t('devicesSettings.addressUnknown')}{' '}
              <a href={PAIRING_DOCS_URL} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
                {t('devicesSettings.addressDocs')}
              </a>
            </p>
          )}
          {address === null && canPublish && <MakeReachable onAddress={setPublished} />}
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('devicesSettings.expired')}</p>
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        {left > 0
          ? (
            <>
              <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => void copy()}>{t('devicesSettings.copy')}</Button>
              {address && (
                <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => void copyAddress()}>{t('devicesSettings.copyAddress')}</Button>
              )}
            </>
          )
          : <Button type="button" size="sm" className="h-7 text-[12px]" disabled={busy} onClick={onRenew}>{t('devicesSettings.newCode')}</Button>}
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onDismiss}>{t('devicesSettings.dismiss')}</Button>
      </div>
    </section>
  );
}

/** Its card in the gallery: the search matches the module id and nothing else. */
const MACHINES_CARD_HREF = `/plugins?q=${encodeURIComponent(MACHINES_MODULE)}`;

function machinesOffCause(here: Extract<MachinesHere, { on: false }>): string {
  if (here.cause === 'licence') return t('devicesSettings.enterCodeOff.licence');
  if (here.cause === 'off' || here.reason === null) return t('devicesSettings.enterCodeOff.off');
  return t('devicesSettings.enterCodeOff.other', { reason: here.reason });
}

/** Why a code cannot be entered on this computer, and where to change that. */
function EnterCodeHelp({ here, onClose }: { here: Extract<MachinesHere, { on: false }>; onClose: () => void }): ReactElement {
  return (
    <section role="status" className="space-y-2 rounded-md bg-muted/30 px-4 py-3">
      <h3 className="text-[13px] font-medium">{t('devicesSettings.enterCodeOff.title')}</h3>
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">
        {t('devicesSettings.enterCodeOff.lead', { path: machinesSettingsPath() })}
      </p>
      <p className="max-w-[65ch] text-[12px] leading-snug">{machinesOffCause(here)}</p>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Link href={MACHINES_CARD_HREF} className="text-[12px] text-foreground underline underline-offset-4">
          {t('devicesSettings.enterCodeOff.open')}
        </Link>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onClose}>{t('devicesSettings.dismiss')}</Button>
      </div>
    </section>
  );
}

function RenameForm({ device, onDone }: { device: PairedDevice; onDone: (renamed: PairedDevice | null) => void }): ReactElement {
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);
  const clean = cleanDeviceName(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (clean === null) return;
    if (clean === device.name) { onDone(null); return; }
    setBusy(true);
    const result = await renameDevice(device.id, clean);
    setBusy(false);
    if (!result.ok) { toast.error(errorMessage(result)); return; }
    toast.success(t('devicesSettings.renamed'));
    onDone(result.value);
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-center gap-2">
      <input
        aria-label={t('devicesSettings.renameLabel')}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-[12px]"
        value={name}
        maxLength={DEVICE_NAME_MAX}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onDone(null); } }}
      />
      <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || clean === null}>{t('devicesSettings.save')}</Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => onDone(null)}>{t('devicesSettings.cancel')}</Button>
    </form>
  );
}

function DeviceRow({ device, ownerId, onChanged }: {
  device: PairedDevice;
  ownerId: string | null;
  onChanged: (device: PairedDevice) => void;
}): ReactElement {
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    const result = await revokeDevice(device.id);
    setBusy(false);
    setMode('view');
    if (!result.ok) { toast.error(errorMessage(result)); return; }
    toast.success(t('devicesSettings.revoked'));
    onChanged({ ...result.value, current: device.current });
  };

  const live = device.status !== 'revoked';
  return (
    <li className="space-y-2 rounded-md bg-muted/30 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          {mode === 'rename' ? (
            <RenameForm device={device} onDone={(renamed) => { setMode('view'); if (renamed) onChanged({ ...renamed, current: device.current }); }} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[13px] font-medium">{device.name}</span>
              <StatusChip device={device} />
              {device.current && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">{t('devicesSettings.current')}</span>}
              {ownerId !== null && device.user_id !== ownerId && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{t('devicesSettings.otherAccount')}</span>
              )}
            </div>
          )}
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {t('devicesSettings.lastSeen', { date: formatDate(device.last_seen_at) })}
            {device.last_ip && (
              <> · <span title={t('devicesSettings.lastIpHint')}>{t('devicesSettings.lastIp', { ip: device.last_ip })}</span></>
            )}
          </p>
          <p className="text-[11px] tabular-nums text-muted-foreground">{t('devicesSettings.pairedOn', { date: formatDate(device.created_at) })}</p>
        </div>
        {live && mode === 'view' && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={() => setMode('rename')}>{t('devicesSettings.rename')}</Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px] text-destructive" onClick={() => setMode('confirm')}>{t('devicesSettings.revoke')}</Button>
          </div>
        )}
      </div>
      {mode === 'confirm' && (
        <div role="alertdialog" aria-label={t('devicesSettings.revoke')} className="space-y-2 rounded-md bg-destructive/10 px-3 py-2">
          <p className="text-[12px] leading-snug">
            {t(device.current ? 'devicesSettings.revokeConfirmCurrent' : 'devicesSettings.revokeConfirm', { name: device.name })}
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" className="h-7 text-[12px]" disabled={busy} onClick={() => void revoke()}>
              {t('devicesSettings.revokeAction')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy} onClick={() => setMode('view')}>
              {t('devicesSettings.cancel')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function DevicesSettings(): ReactElement {
  const me = useMe();
  const caps = useCapabilities();
  const settings = useSettingsNavigation();
  // Read after mount: the server renders without the attribute's say.
  const [remote, setRemote] = useState(false);
  useEffect(() => { setRemote(activeMachineId() !== LOCAL_MACHINE_ID); }, []);
  const machines = machinesModuleHere(caps, remote);
  const [explainEntry, setExplainEntry] = useState(false);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [issuing, setIssuing] = useState(false);
  const known = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const result = await listDevices();
    if (!result.ok) { setLoadFailed(true); return null; }
    setLoadFailed(false);
    setDevices(result.value);
    return result.value;
  }, []);
  useEffect(() => { void load(); }, [load]);

  const issue = async () => {
    setIssuing(true);
    const result = await issuePairingCode();
    setIssuing(false);
    if (!result.ok) { toast.error(errorMessage(result)); return; }
    // Only a list actually loaded is a baseline: taken from a failed or pending
    // load it would be empty, and every existing device would pass for the one
    // that redeemed the code — closing it before anyone used it.
    known.current = devices === null ? null : new Set(devices.map((device) => device.id));
    setCode(result.value);
  };

  // A device that redeems the code shows up in the list; the code is spent, so it goes.
  const live = code !== null && code.expiresAt > Date.now();
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void load().then((rows) => {
        if (!rows) return;
        // No baseline yet: this first list that loads becomes it.
        if (!known.current) { known.current = new Set(rows.map((device) => device.id)); return; }
        if (rows.some((device) => !known.current!.has(device.id))) setCode(null);
      });
    }, REDEEM_POLL_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  const replace = useCallback((changed: PairedDevice) => {
    setDevices((rows) => rows?.map((row) => (row.id === changed.id ? changed : row)) ?? rows);
  }, []);

  const enterCode = () => {
    if (machines === null) return;
    if (!machines.on) { setExplainEntry(true); return; }
    requestAddMachine();
    settings.select({ category: 'plugins', tab: MACHINES_MODULE });
  };

  const ordered = devices ? sortDevices(devices) : [];
  return (
    <div className="space-y-6">
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('devicesSettings.description')}</p>
      {code && (
        <PairingCodeCard
          code={code}
          busy={issuing}
          canPublish={!remote && me?.user?.is_superadmin === true}
          onRenew={() => void issue()}
          onDismiss={() => setCode(null)}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {!code && (
          <Button type="button" size="sm" className="h-8 text-[12px]" disabled={issuing} onClick={() => void issue()}>
            {t('devicesSettings.authorize')}
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" className="h-8 text-[12px]" disabled={machines === null} onClick={enterCode}>
          {t('devicesSettings.enterCode')}
        </Button>
      </div>
      {explainEntry && machines !== null && !machines.on && <EnterCodeHelp here={machines} onClose={() => setExplainEntry(false)} />}
      <section className="space-y-2">
        <h3 className="text-[13px] font-medium">{t('devicesSettings.listTitle')}</h3>
        {loadFailed && <p className="text-[12px] text-destructive">{t('devicesSettings.loadError')}</p>}
        {devices !== null && ordered.length === 0 && <p className="text-[12px] text-muted-foreground">{t('devicesSettings.empty')}</p>}
        {ordered.length > 0 && (
          <ul className="space-y-2">
            {ordered.map((device) => (
              <DeviceRow key={device.id} device={device} ownerId={actingUser(me)?.id ?? null} onChanged={replace} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
