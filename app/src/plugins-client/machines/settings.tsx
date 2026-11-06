'use client';

/**
 * Settings → Machines, the plugin's own category (`settings.section`): pair
 * another Timon machine with a one-time code, see its state and version,
 * rename it, check it, switch to it, take it out of the fleet.
 *
 * The fleet is this computer's (`/api/ui/machines*`, anchored on the local
 * daemon), whatever machine the window currently drives. Each machine says
 * under which account this computer acts there — the account that issued the
 * pairing code, which may not be the one signed in here.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiLevelVerdict } from '@/lib/machines/api-level';
import {
  cleanMachineName, fleetErrorKind, MACHINE_NAME_MAX, MACHINE_URL_MAX, normalizeMachineUrl, pairMachine, probeMachine,
  remoteAccountLabel, removeMachine, renameMachine, switchToLocal, switchToMachine,
  type FleetFailure, type FleetMachine,
} from '@/lib/machines/fleet';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { settingsPath } from '@/lib/settings-path';
import { onAddRequest, refreshFleet, takeAddRequest, updateFleetMachine, useFleet } from './fleet-store';
import { StatusDot } from './status-dot';

const INPUT = 'h-8 w-full min-w-0 rounded-md border border-border bg-background px-2 text-[12.5px]';

function errorMessage(failure: FleetFailure): string {
  return t(`machines.errors.${fleetErrorKind(failure)}`);
}

function formatDate(ms: number): string {
  return formatDateTime(ms, { dateStyle: 'medium', timeStyle: 'short' });
}

function AddMachineForm({ onDone }: { onDone: () => void }): ReactElement {
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanName = name.trim() === '' ? undefined : cleanMachineName(name);
  const ready = url.trim() !== '' && code.trim() !== '' && cleanName !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const result = await pairMachine({ url: normalizeMachineUrl(url), code: code.trim(), ...(cleanName ? { name: cleanName } : {}) });
    setBusy(false);
    if (!result.ok) { setError(errorMessage(result)); return; }
    toast.success(t(result.value.created ? 'machines.settings.paired' : 'machines.settings.repaired', { name: result.value.machine.name }));
    await refreshFleet();
    onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} aria-label={t('machines.settings.addTitle')} className="space-y-3 rounded-md bg-muted/30 px-4 py-3">
      <h3 className="text-[13px] font-medium">{t('machines.settings.addTitle')}</h3>
      <p className="max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('machines.settings.addHint', { settingsPath: settingsPath('network', 'devices') })}</p>
      <label className="block space-y-1 text-[12px]">
        <span>{t('machines.settings.urlLabel')}</span>
        <input
          className={INPUT}
          // Not `type="url"`: the browser would refuse a bare host, which
          // gets `https://` added before it is sent.
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={t('machines.settings.urlPlaceholder')}
          maxLength={MACHINE_URL_MAX}
          value={url}
          autoFocus
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-[12px]">
        <span>{t('machines.settings.codeLabel')}</span>
        {/* Retyped by a person from the other screen: the product font, tracked out, stable digits. */}
        <input
          className={`${INPUT} tracking-[0.15em] tabular-nums`}
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={64}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <label className="block space-y-1 text-[12px]">
        <span>{t('machines.settings.nameLabel')}</span>
        <input className={INPUT} maxLength={MACHINE_NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {error && <p role="alert" className="text-[12px] text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || !ready}>
          {busy ? t('machines.settings.pairing') : t('machines.settings.pair')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy} onClick={onDone}>
          {t('machines.settings.cancel')}
        </Button>
      </div>
    </form>
  );
}

function RenameForm({ machine, onDone }: { machine: FleetMachine; onDone: () => void }): ReactElement {
  const [name, setName] = useState(machine.name);
  const [busy, setBusy] = useState(false);
  const clean = cleanMachineName(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (clean === null) return;
    if (clean === machine.name) { onDone(); return; }
    setBusy(true);
    const result = await renameMachine(machine.id, clean);
    setBusy(false);
    if (!result.ok) { toast.error(errorMessage(result)); return; }
    updateFleetMachine(result.value);
    toast.success(t('machines.settings.renamed'));
    onDone();
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-center gap-2">
      <input
        aria-label={t('machines.settings.renameLabel')}
        className={`${INPUT} h-7 flex-1`}
        value={name}
        maxLength={MACHINE_NAME_MAX}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onDone(); } }}
      />
      <Button type="submit" size="sm" className="h-7 text-[12px]" disabled={busy || clean === null}>{t('machines.settings.save')}</Button>
      <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onDone}>{t('machines.settings.cancel')}</Button>
    </form>
  );
}

function versionLine(machine: FleetMachine): string {
  const version = machine.version ? t('machines.settings.version', { version: machine.version }) : t('machines.settings.versionUnknown');
  const verdict = apiLevelVerdict(machine.api_level);
  if (machine.status !== 'online' && machine.api_level === null) return version;
  if (verdict === 'newer') return `${version} · ${t('machines.settings.apiNewer')}`;
  if (verdict === 'too_old') return `${version} · ${t('machines.settings.apiTooOld')}`;
  if (verdict === 'unknown') return `${version} · ${t('machines.settings.apiUnknown')}`;
  return version;
}

function MachineRow({ machine, active }: { machine: FleetMachine; active: boolean }): ReactElement {
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const [busy, setBusy] = useState<'check' | 'switch' | 'remove' | null>(null);
  const account = remoteAccountLabel(machine);

  const check = async () => {
    setBusy('check');
    const result = await probeMachine(machine.id);
    setBusy(null);
    if (!result.ok) { toast.error(errorMessage(result)); return; }
    updateFleetMachine(result.value.machine);
    if (result.value.reachable) toast.success(t('machines.settings.online', { name: machine.name }));
    else toast.error(t(`machines.errors.${fleetErrorKind({ status: 502, error: 'machine_unreachable', detail: result.value.machine.status })}`));
  };

  const go = async () => {
    setBusy('switch');
    const outcome = await switchToMachine(machine.id);
    // A page kept alive by the desktop comes back as it was left: not busy.
    if (outcome.ok) { if (outcome.kept) setBusy(null); return; }
    setBusy(null);
    toast.error(errorMessage(outcome));
    void refreshFleet();
  };

  const remove = async () => {
    setBusy('remove');
    const result = await removeMachine(machine.id);
    if (!result.ok) { setBusy(null); setMode('view'); toast.error(errorMessage(result)); return; }
    toast.success(t(result.value.remoteRevoked ? 'machines.settings.removed' : 'machines.settings.removedNotRevoked'));
    // This window was driving it: nothing is left to drive, go home. A page
    // the desktop keeps alive is settled like any other.
    if (active) {
      const outcome = await switchToLocal();
      if (!outcome.ok || !outcome.kept) return;
    }
    setBusy(null);
    setMode('view');
    await refreshFleet();
  };

  return (
    <li className="space-y-2 rounded-md bg-muted/30 px-3 py-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          {mode === 'rename' ? (
            <RenameForm machine={machine} onDone={() => setMode('view')} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot status={machine.status} />
              <span className="truncate text-[13px] font-medium">{machine.name}</span>
              <span className="text-[11px] text-muted-foreground">{t(`machines.status.${machine.status}`)}</span>
              {active && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">{t('machines.settings.active')}</span>}
            </div>
          )}
          <p className="break-all text-[11px] text-muted-foreground">{machine.url}</p>
          {account && (
            <p className="text-[11px] text-muted-foreground">
              {t(machine.remote_user.is_superadmin ? 'machines.settings.actingAsAdmin' : 'machines.settings.actingAs', { account })}
            </p>
          )}
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {versionLine(machine)}
            {' · '}
            {machine.last_ok_at ? t('machines.settings.lastSeen', { date: formatDate(machine.last_ok_at) }) : t('machines.settings.neverSeen')}
          </p>
        </div>
        {mode === 'view' && (
          <div className="flex shrink-0 flex-wrap items-center gap-1">
            {!active && (
              <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={busy !== null} onClick={() => void go()}>
                {t('machines.settings.switchTo')}
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy !== null} onClick={() => void check()}>
              {busy === 'check' ? t('machines.settings.checking') : t('machines.settings.check')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy !== null} onClick={() => setMode('rename')}>
              {t('machines.settings.rename')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px] text-destructive" disabled={busy !== null} onClick={() => setMode('confirm')}>
              {t('machines.settings.remove')}
            </Button>
          </div>
        )}
      </div>
      {mode === 'confirm' && (
        <div role="alertdialog" aria-label={t('machines.settings.remove')} className="space-y-2 rounded-md bg-destructive/10 px-3 py-2">
          <p className="text-[12px] leading-snug">{t('machines.settings.removeConfirm', { name: machine.name })}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" className="h-7 text-[12px]" disabled={busy !== null} onClick={() => void remove()}>
              {t('machines.settings.removeAction')}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-7 text-[12px]" disabled={busy !== null} onClick={() => setMode('view')}>
              {t('machines.settings.cancel')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function MachinesSettings(): ReactElement {
  const fleet = useFleet();
  const [adding, setAdding] = useState(false);
  const [activeId, setActiveId] = useState<string>(LOCAL_MACHINE_ID);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => { setActiveId(activeMachineId()); }, []);

  // "Add a machine…" from the switcher: open the form, now or once mounted.
  const openIfAsked = useCallback(() => { if (takeAddRequest()) setAdding(true); }, []);
  useEffect(() => {
    openIfAsked();
    return onAddRequest(openIfAsked);
  }, [openIfAsked]);

  const local = activeId === LOCAL_MACHINE_ID;
  const backHome = async () => {
    setLeaving(true);
    const outcome = await switchToLocal();
    if (outcome.ok) { if (outcome.kept) setLeaving(false); return; }
    setLeaving(false);
    toast.error(errorMessage(outcome));
  };

  return (
    <div className="space-y-6">
      <p className="max-w-[65ch] text-[13px] leading-snug text-muted-foreground">{t('machines.settings.description')}</p>

      <section className="flex flex-col gap-2 rounded-md bg-muted/30 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot status="online" />
            <span className="text-[13px] font-medium">{t('machines.thisComputer')}</span>
            {local && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary">{t('machines.settings.active')}</span>}
          </div>
          <p className="text-[11px] text-muted-foreground">{t('machines.settings.local')}</p>
        </div>
        {!local && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-[12px]" disabled={leaving} onClick={() => void backHome()}>
            {t('machines.backToLocal')}
          </Button>
        )}
      </section>

      {adding
        ? <AddMachineForm onDone={() => setAdding(false)} />
        : (
          <Button type="button" size="sm" className="h-8 text-[12px]" onClick={() => setAdding(true)}>
            {t('machines.settings.add')}
          </Button>
        )}

      <section className="space-y-2">
        <h3 className="text-[13px] font-medium">{t('machines.settings.listTitle')}</h3>
        {fleet.failed && <p role="alert" className="text-[12px] text-destructive">{t('machines.settings.loadError')}</p>}
        {fleet.machines !== null && fleet.machines.length === 0 && (
          <p className="text-[12px] text-muted-foreground">{t('machines.settings.empty')}</p>
        )}
        {fleet.machines !== null && fleet.machines.length > 0 && (
          <ul className="space-y-2">
            {fleet.machines.map((machine) => <MachineRow key={machine.id} machine={machine} active={machine.id === activeId} />)}
          </ul>
        )}
      </section>
    </div>
  );
}
