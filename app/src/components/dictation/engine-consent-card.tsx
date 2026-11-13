'use client';

import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import { Mic } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { decideEngineConsent, engineConsent, subscribeEngineConsent, type ConsentRequest } from '@/lib/dictation/consent';
import { dictationPluginLabel, engineDestination, voiceDestinationLine } from '@/lib/dictation/destination';
import { t } from '@/lib/i18n';
import { listMachines } from '@/lib/machines/fleet';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { activeMachineId } from '@/lib/machines/machine-storage';

/**
 * The card a first dictation with a plugin's engine opens (TODO #484 C3,
 * vault §3.4): which engine, which plugin brings it, where the voice goes —
 * named from the manifest, never from the engine — and on which machine the
 * answer holds. Nothing is captured before Allow; Don't allow leaves the
 * engine unusable, with no other engine tried in its place.
 *
 * Shown through the app's single toaster, like the local model's card:
 * `/chat`, `/agents` and `/multichat` have no `overlay` layer.
 */

/** The active machine as a sentence names it: "this computer", or its fleet name. */
export function useActiveMachineName(): string {
  const [name, setName] = useState(() => t('dictation.machine.thisComputer'));
  useEffect(() => {
    const id = activeMachineId();
    if (id === LOCAL_MACHINE_ID) return;
    let live = true;
    setName(id);
    void listMachines().then((result) => {
      const machine = result.ok ? result.value.find((m) => m.id === id) : undefined;
      if (live && machine) setName(machine.name);
    }).catch(() => {});
    return () => { live = false; };
  }, []);
  return name;
}

function useConsent(pluginId: string, engineId: string) {
  return useSyncExternalStore(
    subscribeEngineConsent,
    () => engineConsent(pluginId, engineId),
    () => 'ask' as const,
  );
}

export function EngineConsentCard({ request, onClose }: { request: ConsentRequest; onClose: () => void }): ReactElement {
  const consent = useConsent(request.pluginId, request.engineId);
  const machine = useActiveMachineName();
  const destination = engineDestination(request.pluginId, request.engineId);
  const titleId = `dictation-engine-consent-${request.engineId}`;

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      className="w-[min(22rem,calc(100vw-2rem))] space-y-3 rounded-xl bg-background p-4 text-foreground shadow-lg ring-1 ring-foreground/5"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Mic className="size-4" />
        </span>
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="text-[13px] font-semibold leading-snug">
            {t('dictation.consent.title', { engine: request.engineLabel })}
          </h2>
          <p className="text-[12px] leading-snug text-muted-foreground">
            {t('dictation.consent.from', { plugin: dictationPluginLabel(request.pluginId) })}
          </p>
        </div>
      </div>
      <p className="rounded-lg bg-muted/50 px-3 py-2 text-[12px] font-medium leading-snug">
        {voiceDestinationLine(destination, machine)}
      </p>
      {consent === 'granted' ? (
        <>
          <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.consent.granted')}</p>
          <Button size="sm" variant="secondary" onClick={onClose}>{t('dictation.consent.close')}</Button>
        </>
      ) : consent === 'ask' ? (
        <>
          <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.consent.scope', { machine })}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => { decideEngineConsent(request.pluginId, request.engineId, 'granted'); }}>
              {t('dictation.consent.allow')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { decideEngineConsent(request.pluginId, request.engineId, 'refused'); onClose(); }}
            >
              {t('dictation.consent.deny')}
            </Button>
          </div>
        </>
      ) : (
        // Refused meanwhile (another window, the Voice pane), or the plugin
        // no longer declares where the voice goes: nothing left to answer here.
        <Button size="sm" variant="ghost" onClick={onClose}>{t('dictation.consent.close')}</Button>
      )}
    </div>
  );
}

/** Opens the card for `request`; true once it is on screen. One card per engine. */
export function presentEngineConsent(request: ConsentRequest): boolean {
  if (typeof window === 'undefined') return false;
  const id = `dictation-engine-consent:${request.pluginId}:${request.engineId}`;
  const close = () => { toast.dismiss(id); };
  toast.custom(() => <EngineConsentCard request={request} onClose={close} />, {
    id,
    duration: Number.POSITIVE_INFINITY,
    unstyled: true,
  });
  return true;
}
