'use client';

/**
 * The machine switcher, at the foot of the nav (`nav.footer`): the machine
 * this window drives, with its state, and a menu of the fleet — this computer
 * first —, "Add a machine…" and "Manage connections".
 *
 * Everything it reads and writes goes through `/api/ui/machines*`, anchored on
 * the local daemon: on a remote machine that lacks the plugin, or has gone
 * quiet, it is still here, and so is the way back. Choosing a machine is a
 * full document load on this same origin, or, in a desktop window that keeps
 * pages, this page hidden alive (`switchToMachine`).
 *
 * On a remote machine it also says under which account this computer acts
 * there: the device token's, which may not be the account signed in here.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Laptop, Plus, Server, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useHoldNavExpanded, useNavChrome } from '@/components/nav-link';
import { fleetErrorKind, remoteAccountLabel, switchToMachine, type FleetMachine, type MachineStatus } from '@/lib/machines/fleet';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { useSettingsNavigation } from '@/lib/settings-navigation';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { MachineBanner } from './banner';
import { refreshFleet, requestAddMachine, useFleet } from './fleet-store';
import { MACHINES_SETTINGS_TARGET } from './settings-target';
import { StatusDot } from './status-dot';

function MachineIcon({ local, status }: { local: boolean; status: MachineStatus }): ReactElement {
  const Icon = local ? Laptop : Server;
  return (
    <span className="relative shrink-0">
      <Icon className="size-4" aria-hidden />
      <StatusDot status={status} className="absolute -bottom-0.5 -right-0.5 size-1.5 ring-2 ring-background" />
    </span>
  );
}

export function MachineSwitcher(): ReactElement {
  const { expanded, forceLabel } = useNavChrome();
  const showLabel = expanded || forceLabel;
  const fleet = useFleet();
  const settings = useSettingsNavigation();
  const [switching, setSwitching] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useHoldNavExpanded(open);
  // Read after mount: the server renders the nav without the attribute's say.
  const [activeId, setActiveId] = useState<string>(LOCAL_MACHINE_ID);
  useEffect(() => { setActiveId(activeMachineId()); }, []);

  const local = activeId === LOCAL_MACHINE_ID;
  const active: FleetMachine | null = local ? null : fleet.machines?.find((m) => m.id === activeId) ?? null;
  const name = local ? t('machines.thisComputer') : active?.name ?? '…';
  const account = active ? remoteAccountLabel(active) : null;
  const status: MachineStatus = local ? 'online' : active?.status ?? 'unknown';

  const go = async (id: string, label: string) => {
    if (id === activeId) return;
    setSwitching(label);
    const outcome = await switchToMachine(id);
    if (outcome.ok) {
      // A reload replaces this page: "Switching to…" stays until it does.
      // Kept alive by the desktop instead, the page comes back when its
      // machine is chosen again: it must name that machine, not the one it
      // left for (TIM-0139).
      if (outcome.kept) setSwitching(null);
      return;
    }
    setSwitching(null);
    toast.error(t(`machines.errors.${fleetErrorKind(outcome)}`));
    void refreshFleet();
  };

  const title = switching ? t('machines.switcher.switching', { name: switching }) : name;
  return (
    <>
      {/* Non-modal: two items open the Settings dialog. A modal menu still
          closing while the dialog mounts leaves `pointer-events: none` on
          <body>, and the page stops answering (TIM-0035, TIM-0010). */}
      <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('machines.switcher.trigger', { name })}
            title={showLabel ? undefined : title}
            disabled={switching !== null}
            className={cn(
              'flex w-full items-center gap-3 overflow-hidden whitespace-nowrap rounded-md px-3 py-2 text-left text-[12.5px] transition-colors',
              // Another machine is driven: it must show at a glance.
              local ? 'text-muted-foreground hover:bg-muted hover:text-foreground' : 'bg-primary/10 text-primary hover:bg-primary/15',
            )}
          >
            <MachineIcon local={local} status={status} />
            {showLabel && (
              <>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{title}</span>
                  {account && !switching && (
                    <span className="truncate text-[11px] opacity-80">{t('machines.switcher.actingAs', { account })}</span>
                  )}
                </span>
                <ChevronsUpDown className="size-3.5 shrink-0 opacity-70" aria-hidden />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        {/* Above the trigger, from the nav's left edge: on the right it left
            the rail, which folded under it. */}
        <DropdownMenuContent side="top" align="start" className="w-72 max-w-[calc(100vw-1rem)]">
          <DropdownMenuLabel className="text-[12px] text-muted-foreground">{t('machines.switcher.menuTitle')}</DropdownMenuLabel>
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => void go(LOCAL_MACHINE_ID, t('machines.thisComputer'))} className="gap-2.5">
              <MachineIcon local status="online" />
              <span className="min-w-0 flex-1 truncate">{t('machines.thisComputer')}</span>
              {local && <Check className="size-4 text-primary" aria-label={t('machines.switcher.active')} />}
            </DropdownMenuItem>
            {(fleet.machines ?? []).map((machine) => {
              const as = remoteAccountLabel(machine);
              return (
                <DropdownMenuItem key={machine.id} onSelect={() => void go(machine.id, machine.name)} className="gap-2.5">
                  <MachineIcon local={false} status={machine.status} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{machine.name}</span>
                    {as && <span className="truncate text-[11px] text-muted-foreground">{t('machines.switcher.actingAs', { account: as })}</span>}
                  </span>
                  {machine.id === activeId && <Check className="size-4 text-primary" aria-label={t('machines.switcher.active')} />}
                </DropdownMenuItem>
              );
            })}
            {fleet.failed && fleet.machines === null && (
              <p role="alert" className="px-2 py-1.5 text-[12px] text-destructive">{t('machines.switcher.loadError')}</p>
            )}
          </DropdownMenuGroup>
          <DropdownMenuGroup className="mt-1.5">
            <DropdownMenuItem onSelect={() => { requestAddMachine(); settings.open(MACHINES_SETTINGS_TARGET); }} className="gap-2.5">
              <Plus className="size-4" aria-hidden />
              {t('machines.switcher.add')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { settings.open(MACHINES_SETTINGS_TARGET); }} className="gap-2.5">
              <Settings2 className="size-4" aria-hidden />
              {t('machines.switcher.manage')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The rail and the drawer both mount a switcher; one banner is enough,
          and the rail's is mounted on every screen size (the drawer is only
          translated off-screen, the rail only hidden by CSS). */}
      {!forceLabel && !local && typeof document !== 'undefined'
        && createPortal(<MachineBanner machineId={activeId} machine={active} />, document.body)}
    </>
  );
}
