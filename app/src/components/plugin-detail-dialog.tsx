'use client';

/**
 * Marketplace-style sheet for one plugin.
 *
 * The gallery card is a summary: cover, title, kinds, one-line pitch, switch.
 * Everything else — author, long copy, slots, the settings a plugin declares,
 * why it is off — lives here. The media well at the top is sized for a
 * carousel: today it shows the cover (or a placeholder); `screenshots[]` is
 * already on the DTO, empty, waiting for stills.
 *
 * A bundle drills into its `contains` without stacking dialogs: the sheet
 * swaps to the child, with a back control to the pack. Each child stays a
 * plugin of its own (toggle, kinds) — that is the U.8 contract.
 */
import { useEffect, useState } from 'react';
import { Blocks, ChevronLeft } from 'lucide-react';
import { PluginMediaCarousel } from '@/components/plugin-media-carousel';
import { Picto } from '@/components/picto';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { PluginKindBadge } from '@/components/plugin-kind-badge';
import { VoiceDestinationLines } from '@/components/dictation/voice-destination-lines';
import type { PluginCardData } from '@/components/plugin-card';
import { containedEntries, mediaSlides } from '@/lib/plugin-gallery';
import { t } from '@/lib/i18n';

export function PluginDetailDialog({
  plugin,
  catalog = [],
  open,
  onOpenChange,
  onToggle,
  busyId,
}: {
  plugin: PluginCardData;
  catalog?: PluginCardData[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  busyId?: string | null;
}): React.ReactElement {
  const [stack, setStack] = useState<string[]>([plugin.id]);
  useEffect(() => {
    if (open) setStack([plugin.id]);
  }, [open, plugin.id]);

  const lookup = (id: string): PluginCardData | undefined =>
    catalog.find((p) => p.id === id) ?? (id === plugin.id ? plugin : undefined);
  const current = lookup(stack[stack.length - 1] ?? plugin.id) ?? plugin;
  const parentId = stack.length > 1 ? stack[stack.length - 2] : null;
  const parent = parentId ? lookup(parentId) : null;
  const blocked = current.blockedReason !== null;
  const locked = current.locked === true;
  const isBundle = current.kinds.includes('bundle');
  const backendOnly = current.kinds.length === 1 && current.kinds[0] === 'behavior';
  const inserts = [...current.slots, ...(current.route ? [current.route] : [])];
  const declareEntries = Object.entries(current.declares);
  const author = current.author ?? (current.source === 'third-party' ? current.pkg : t('pluginsPage.authorUnknown'));
  const children = catalog.length > 0 ? containedEntries(current.contains, catalog) : [];
  const busy = busyId === current.id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90vh,780px)] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <PluginMediaCarousel slides={mediaSlides(current)} iconUrl={current.iconUrl ?? null} />

        <ScrollArea className="max-h-[min(55vh,480px)]">
          <div className="flex flex-col gap-4 p-6 pt-5">
            {parent && (
              <button
                type="button"
                onClick={() => setStack((s) => s.slice(0, -1))}
                className="flex items-center gap-1 self-start text-[12px] text-muted-foreground hover:text-foreground"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                {t('pluginsPage.backTo', { name: parent.label })}
              </button>
            )}

            <DialogHeader className="space-y-3 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <DialogTitle className="text-base">{current.label}</DialogTitle>
                  <p className="mt-1 m-0 text-[11px] text-muted-foreground">
                    {current.id}
                    {current.version ? ` · ${current.version}` : ''}
                    {' · '}
                    {t('pluginsPage.by', { name: author })}
                  </p>
                </div>
                {onToggle && current.enabled !== null && (
                  <Switch
                    checked={current.enabled}
                    disabled={blocked || locked || busy}
                    onCheckedChange={(next) => onToggle(current.id, next)}
                    aria-label={t(current.enabled ? 'pluginsPage.disable' : 'pluginsPage.enable', { name: current.label })}
                  />
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {current.kinds.map((kind) => <PluginKindBadge key={kind} kind={kind} />)}
                {current.tier && (
                  <Badge variant="outline" className="text-[11px] font-medium text-muted-foreground">
                    {t(`pluginsPage.tier.${current.tier}`)}
                  </Badge>
                )}
              </div>
              <DialogDescription className={current.description || backendOnly
                ? 'text-sm leading-relaxed text-muted-foreground'
                : 'sr-only'}
              >
                {current.description ?? (backendOnly ? t('pluginsPage.backendHint') : current.label)}
              </DialogDescription>
            </DialogHeader>

            {children.length > 0 && (
              <section className="space-y-2">
                <h3 className="m-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {t('pluginsPage.contains')}
                </h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {children.map(({ id, plugin: child }) => (
                    <li key={id}>
                      {child
                        ? (
                          <ContainedRow
                            plugin={child}
                            busy={busyId === child.id}
                            onOpen={() => setStack((s) => [...s, child.id])}
                            onToggle={onToggle}
                          />
                        )
                        : (
                          <div className="flex items-center gap-3 rounded-md border border-dashed border-border px-3 py-2">
                            <Blocks className="h-5 w-5 shrink-0 text-muted-foreground/50" aria-hidden />
                            <div className="min-w-0">
                              <p className="m-0 truncate text-[12px]">{id}</p>
                              <p className="m-0 text-[11px] text-muted-foreground">{t('pluginsPage.containedMissing')}</p>
                            </div>
                          </div>
                        )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <VoiceDestinationLines lines={current.voice ?? []} />

            <dl className="m-0 space-y-2 text-[12px]">
              {!isBundle && (
                <Row
                  label={t('pluginsPage.inserts')}
                  values={inserts}
                  empty={backendOnly ? t('pluginsPage.backendHint') : t('pluginsPage.insertsNone')}
                />
              )}
              {declareEntries.length > 0 && (
                <Row
                  label={t('pluginsPage.declares')}
                  values={declareEntries.map(([name, mode]) => `${name} (${mode})`)}
                />
              )}
              {children.length === 0 && current.contains.length > 0 && (
                <Row label={t('pluginsPage.contains')} values={current.contains} />
              )}
              {current.modifies.length > 0 && <Row label={t('pluginsPage.modifies')} values={current.modifies} />}
              {current.settings.length > 0 && (
                <Row label={t('pluginsPage.settings')} values={current.settings.map((s) => s.label)} />
              )}
            </dl>

            {current.note && (
              <p className="m-0 text-[12px] text-muted-foreground">{current.note}</p>
            )}
            {blocked && (
              <p className="m-0 rounded bg-amber-500/10 px-2 py-1.5 text-[12px] text-amber-700 dark:text-amber-400">
                {current.blockedReason}
              </p>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function ContainedRow({
  plugin,
  busy,
  onOpen,
  onToggle,
}: {
  plugin: PluginCardData;
  busy: boolean;
  onOpen: () => void;
  onToggle?: (id: string, enabled: boolean) => void;
}): React.ReactElement {
  const blocked = plugin.blockedReason !== null;
  const locked = plugin.locked === true;
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-muted/20 px-3 py-2">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted/60">
          {plugin.coverUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={plugin.coverUrl} alt="" className="h-full w-full object-cover" />
            : plugin.iconUrl
              ? <Picto icon={plugin.iconUrl} className="size-5 text-foreground/70" />
              : <Blocks className="h-4 w-4 text-muted-foreground/50" aria-hidden />}
        </div>
        <div className="min-w-0">
          <p className="m-0 truncate text-[13px] font-medium">{plugin.label}</p>
          <p className="m-0 truncate text-[11px] text-muted-foreground">{plugin.id}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {plugin.kinds.map((kind) => <PluginKindBadge key={kind} kind={kind} />)}
          </div>
        </div>
      </button>
      {onToggle && plugin.enabled !== null && (
        <Switch
          checked={plugin.enabled}
          disabled={blocked || locked || busy}
          onCheckedChange={(next) => onToggle(plugin.id, next)}
          aria-label={t(plugin.enabled ? 'pluginsPage.disable' : 'pluginsPage.enable', { name: plugin.label })}
        />
      )}
    </div>
  );
}

function Row({ label, values, empty }: { label: string; values: string[]; empty?: string }): React.ReactElement {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5">
      <dt className="m-0 w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="m-0 flex flex-wrap gap-1">
        {values.length > 0
          ? values.map((value) => (
            <span /* code-font: manifest identifier */ key={value} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {value}
            </span>
          ))
          : <span className="text-muted-foreground/70">{empty}</span>}
      </dd>
    </div>
  );
}
