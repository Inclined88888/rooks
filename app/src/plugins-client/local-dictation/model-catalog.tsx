'use client';

import { useState, type ReactElement } from 'react';

import { Button, getLocale, t } from '@rooks/ui';
import type { EngineAvailability, ModelListing, PackErrorCode } from './desktop-speech';
import { localEngine } from './local-engine';
import { confirmsDownload, formatBytes, languageName, modelStateView } from './model-view';
import { ModelActions, ModelStatusLine } from './model-controls';

/**
 * The catalog of the Voice pane: one card per model — what it weighs, what it
 * needs, what it speaks, whose it is, where it stands — with Download,
 * Cancel and Delete. Grouped like the mock-up (vault note §4): installed,
 * available, brought by plugins, imported by the user. A plugin's model the
 * desktop does not have yet is offered with Add, which opens the desktop's
 * own box (TODO #584).
 */

/** Past this many, the languages are counted rather than named. */
const NAMED_LANGUAGES = 4;

function languagesText(entry: ModelListing, locale: string): string {
  const codes = entry.languages.codes.filter((code) => code !== 'und');
  if (codes.length === 0) return t('dictation.catalog.detects');
  if (codes.length > NAMED_LANGUAGES) return t('dictation.catalog.languageCount', { count: codes.length });
  return codes.map((code) => languageName(code, locale)).join(', ');
}

/** One line of facts: size, memory (the peak when known: what the machine must have free), languages, licence. */
function facts(entry: ModelListing, locale: string): string {
  const parts = [formatBytes(entry.sizeBytes, locale)];
  if (entry.peakRamBytes) parts.push(t('dictation.catalog.peakMemory', { size: formatBytes(entry.peakRamBytes, locale) }));
  else if (entry.ramBytes) parts.push(t('dictation.catalog.memory', { size: formatBytes(entry.ramBytes, locale) }));
  parts.push(languagesText(entry, locale));
  if (entry.license) parts.push(entry.license.spdx);
  return parts.join(' · ');
}

/** What a card says of a model before its buttons: name, facts, where it comes from, licence. */
function ModelDescription({ entry, usedFor }: { entry: ModelListing; usedFor: string[] }): ReactElement {
  const locale = getLocale();
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] font-medium leading-snug">
          {entry.label}
          {entry.tier ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground/80">
              {t(`dictation.catalog.tiers.${entry.tier}`)}
            </span>
          ) : null}
        </p>
        {usedFor.length > 0 ? (
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
            {t('dictation.catalog.usedFor', { languages: usedFor.join(', ') })}
          </span>
        ) : null}
      </div>
      <p className="text-[12px] tabular-nums text-muted-foreground">{facts(entry, locale)}</p>
      {entry.languages.mode === 'required' ? (
        <p className="text-[12px] text-muted-foreground">{t('dictation.catalog.languageRequired')}</p>
      ) : null}
      {entry.interim === 'final-only' ? (
        <p className="text-[12px] text-muted-foreground">{t('dictation.catalog.finalOnly')}</p>
      ) : null}
      {entry.origin.kind === 'pack' ? (
        <p className="text-[12px] text-muted-foreground">{t('dictation.catalog.fromPlugin', { plugin: entry.origin.pluginId })}</p>
      ) : null}
      {entry.origin.kind === 'local' ? (
        <p className="text-[12px] text-amber-700 dark:text-amber-400">{t('dictation.catalog.unverified')}</p>
      ) : null}
      {entry.license ? (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {entry.license.url ? (
            <a href={entry.license.url} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">
              {entry.license.attribution}
            </a>
          ) : entry.license.attribution}
        </p>
      ) : null}
    </>
  );
}

function ModelCard({ entry, engine, usedFor }: { entry: ModelListing; engine: EngineAvailability; usedFor: string[] }): ReactElement {
  const locale = getLocale();
  const store = localEngine();
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A click on Download here IS the consent: a partial download shows as paused.
  const view = modelStateView(engine, entry.state, true);
  const size = formatBytes(entry.sizeBytes, locale);
  const downloadLabel = t('dictation.catalog.download', { size });
  // A large model asks once more before its first byte; a resume or a retry does not.
  const asksFirst = view.phase === 'consent' && confirmsDownload(entry);
  return (
    <li className="space-y-2 rounded-md bg-background/70 p-3">
      <ModelDescription entry={entry} usedFor={usedFor} />
      {view.phase !== 'consent' && view.phase !== 'ready' ? <ModelStatusLine view={view} /> : null}
      {view.phase === 'ready' && store ? (
        <Button
          size="sm"
          variant="outline"
          disabled={deleting}
          onClick={() => {
            setDeleting(true);
            void store.remove(entry.id).finally(() => setDeleting(false));
          }}
        >
          {t('dictation.catalog.delete')}
        </Button>
      ) : asksFirst && !confirming ? (
        <Button size="sm" onClick={() => setConfirming(true)}>{downloadLabel}</Button>
      ) : (
        <>
          {asksFirst ? (
            <p className="rounded-md bg-muted/60 p-2.5 text-[12px] leading-snug tabular-nums">
              {entry.peakRamBytes || entry.ramBytes
                ? t('dictation.catalog.confirmLarge', {
                  model: entry.label, size, memory: formatBytes(entry.peakRamBytes ?? entry.ramBytes ?? 0, locale),
                })
                : t('dictation.catalog.confirmLargeSize', { model: entry.label, size })}
            </p>
          ) : null}
          <ModelActions
            view={view}
            modelId={entry.id}
            downloadLabel={downloadLabel}
            onAccept={() => setConfirming(false)}
            onClose={asksFirst ? () => setConfirming(false) : undefined}
          />
        </>
      )}
    </li>
  );
}

/** Codes whose sentence the pane says itself; `declined` is the user's own answer, said by nothing. */
const PACK_ERROR_KEYS: Partial<Record<PackErrorCode, string>> = {
  invalid: 'invalid', 'unknown-family': 'unknownFamily', exists: 'exists', busy: 'busy',
  'engine-unavailable': 'engineUnavailable', 'not-found': 'notFound', unavailable: 'unavailable',
};

/** A plugin's model the desktop does not have yet: Add opens the desktop's box, which reads the entry again. */
function PackOfferCard({ entry }: { entry: ModelListing }): ReactElement {
  const locale = getLocale();
  const store = localEngine();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<PackErrorCode | null>(null);
  const errorKey = error ? PACK_ERROR_KEYS[error] : undefined;
  return (
    <li className="space-y-2 rounded-md bg-background/70 p-3">
      <ModelDescription entry={entry} usedFor={[]} />
      {errorKey ? <p className="text-[12px] text-destructive">{t(`dictation.catalog.packErrors.${errorKey}`)}</p> : null}
      {store && entry.origin.kind === 'pack' ? (
        <Button
          size="sm"
          disabled={adding}
          onClick={() => {
            if (entry.origin.kind !== 'pack') return;
            setAdding(true);
            setError(null);
            void store.proposePack(entry.origin.pluginId, entry.id)
              .then((result) => { if (result && !result.ok) setError(result.code); else if (!result) setError('unavailable'); })
              .finally(() => setAdding(false));
          }}
        >
          {t('dictation.catalog.addPack', { size: formatBytes(entry.sizeBytes, locale) })}
        </Button>
      ) : null}
    </li>
  );
}

type Group = { key: 'installed' | 'available' | 'plugins' | 'local'; entries: ModelListing[]; offers: readonly ModelListing[] };

export function catalogGroups(models: readonly ModelListing[], offers: readonly ModelListing[] = []): Group[] {
  const groups: Group[] = [
    { key: 'installed', entries: models.filter((entry) => entry.origin.kind !== 'local' && entry.state.status === 'ready'), offers: [] },
    { key: 'available', entries: models.filter((entry) => entry.origin.kind === 'builtin' && entry.state.status !== 'ready'), offers: [] },
    { key: 'plugins', entries: models.filter((entry) => entry.origin.kind === 'pack' && entry.state.status !== 'ready'), offers },
    { key: 'local', entries: models.filter((entry) => entry.origin.kind === 'local'), offers: [] },
  ];
  return groups.filter((group) => group.entries.length > 0 || group.offers.length > 0);
}

export function ModelCatalog({
  models,
  offers = [],
  engine,
  usedFor,
}: {
  models: readonly ModelListing[];
  /** The plugins' entries not in the catalog yet. */
  offers?: readonly ModelListing[];
  engine: EngineAvailability;
  /** Model id → the languages it dictates now. */
  usedFor: ReadonlyMap<string, string[]>;
}): ReactElement {
  return (
    <div className="space-y-3">
      {catalogGroups(models, offers).map((group) => (
        <div key={group.key} className="space-y-2 rounded-lg bg-muted/40 p-3">
          <h4 className="px-1 text-[12px] font-semibold text-muted-foreground">{t(`dictation.catalog.groups.${group.key}`)}</h4>
          <ul className="space-y-2">
            {group.entries.map((entry) => (
              <ModelCard key={entry.id} entry={entry} engine={engine} usedFor={usedFor.get(entry.id) ?? []} />
            ))}
            {group.offers.map((entry) => <PackOfferCard key={entry.id} entry={entry} />)}
          </ul>
        </div>
      ))}
    </div>
  );
}
