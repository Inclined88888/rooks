'use client';

import { useState, type ReactElement } from 'react';
import { Loader2 } from 'lucide-react';

import { Button, t } from '@rooks/ui';
import type { ImportErrorCode, ImportRequest, ImportResult, ModelListing } from './desktop-speech';
import { localEngine } from './local-engine';

/**
 * "Add a local model…" (vault note §2.4, A3): the desktop opens its own
 * folder picker — no path ever leaves this page or comes back to it — then
 * checks, copies and loads the model in a disposable process. What it cannot
 * guess (the kind of model, its languages) it asks for, and the user picks
 * the folder again with the answer.
 */

/** Product names, not translated. */
const FAMILY_NAMES: Record<string, string> = {
  'nemo-transducer': 'NeMo transducer (Parakeet)',
  'nemo-canary': 'NeMo Canary',
  whisper: 'Whisper',
  'cohere-transcribe': 'Cohere Transcribe',
};

export function familyName(family: string): string {
  return FAMILY_NAMES[family] ?? family;
}

export type ImportStep =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'done'; label: string }
  /** The desktop needs the kind of model (`candidates`) or its languages: the user answers, then picks the folder again. */
  | { kind: 'needs'; candidates: string[]; family: string | null }
  | { kind: 'failed'; code: ImportErrorCode };

/** What the pane shows after an answer of the desktop; `request`: what was asked with it. */
export function importStep(result: ImportResult | null, request: ImportRequest, models: readonly ModelListing[] | null): ImportStep {
  if (!result) return { kind: 'failed', code: 'engine-unavailable' };
  if (result.ok) return { kind: 'done', label: models?.find((entry) => entry.id === result.modelId)?.label ?? result.modelId };
  switch (result.code) {
    case 'cancelled':
      return { kind: 'idle' };
    case 'family-needed':
      return { kind: 'needs', candidates: result.candidates, family: null };
    case 'languages-needed':
      return { kind: 'needs', candidates: [], family: request.family ?? null };
    default:
      return { kind: 'failed', code: result.code };
  }
}

/** Language codes typed by the user (`fr, en`); null when one is not a code. */
export function parseLanguageCodes(input: string): string[] | null {
  const parts = input.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!parts.every((code) => /^[a-z]{2,3}$/.test(code))) return null;
  return [...new Set(parts)].slice(0, 200);
}

const ERROR_KEYS: Partial<Record<ImportErrorCode, string>> = {
  'engine-unavailable': 'engineUnavailable',
  'not-a-folder': 'notAFolder',
  'special-file': 'specialFile',
  'nested-folder': 'nestedFolder',
  'file-name': 'fileName',
  'too-many-files': 'tooManyFiles',
  'too-large': 'tooLarge',
  'unsupported-family': 'unsupportedFamily',
  'unsafe-graph': 'unsafeGraph',
  'disk-full': 'diskFull',
  'load-failed': 'loadFailed',
};

export function importErrorKey(code: ImportErrorCode): string {
  return `dictation.import.errors.${ERROR_KEYS[code] ?? code}`;
}

export function ModelImport({ models }: { models: readonly ModelListing[] | null }): ReactElement | null {
  const store = localEngine();
  const [step, setStep] = useState<ImportStep>({ kind: 'idle' });
  const [family, setFamily] = useState<string | null>(null);
  const [languages, setLanguages] = useState('');
  const [invalidLanguages, setInvalidLanguages] = useState(false);
  if (!store) return null;

  const pick = (request: ImportRequest) => {
    setStep({ kind: 'picking' });
    void store.importModel(request).then((result) => {
      const next = importStep(result, request, store.models());
      setStep(next);
      if (next.kind !== 'needs') {
        setFamily(null);
        setLanguages('');
      } else if (next.family) {
        setFamily(next.family);
      }
    });
  };

  const pickAgain = () => {
    const codes = languages.trim() ? parseLanguageCodes(languages) : [];
    if (!codes) {
      setInvalidLanguages(true);
      return;
    }
    setInvalidLanguages(false);
    pick({ ...(family ? { family } : {}), ...(codes.length ? { languages: codes } : {}) });
  };

  const needs = step.kind === 'needs' ? step : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={step.kind === 'picking'} onClick={() => pick({})}>
          {step.kind === 'picking' ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('dictation.import.button')}
        </Button>
        <p className="text-[12px] leading-snug text-muted-foreground">{t('dictation.import.trust')}</p>
      </div>
      {step.kind === 'done' ? (
        <p role="status" className="text-[12px] text-muted-foreground">{t('dictation.import.done', { model: step.label })}</p>
      ) : null}
      {step.kind === 'failed' ? (
        <p role="alert" className="text-[12px] text-destructive">{t(importErrorKey(step.code))}</p>
      ) : null}
      {needs ? (
        <div className="space-y-3 rounded-md bg-background/70 p-3">
          {needs.candidates.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-[12px] font-medium">{t('dictation.import.whichFamily')}</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('dictation.import.whichFamily')}>
                {needs.candidates.map((candidate) => (
                  <Button
                    key={candidate}
                    size="sm"
                    variant={family === candidate ? 'secondary' : 'ghost'}
                    aria-pressed={family === candidate}
                    onClick={() => setFamily(candidate)}
                  >
                    {familyName(candidate)}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="block space-y-1.5">
            <span className="block text-[12px] font-medium">{t('dictation.import.languages')}</span>
            <input
              value={languages}
              onChange={(event) => { setLanguages(event.target.value); setInvalidLanguages(false); }}
              placeholder="fr, en"
              aria-invalid={invalidLanguages}
              className="h-8 w-full max-w-xs rounded-md bg-muted/60 px-2.5 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className={`block text-[12px] ${invalidLanguages ? 'text-destructive' : 'text-muted-foreground'}`}>
              {t(invalidLanguages ? 'dictation.import.languagesInvalid' : 'dictation.import.languagesHint')}
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={needs.candidates.length > 0 && !family} onClick={pickAgain}>
              {t('dictation.import.pickAgain')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setStep({ kind: 'idle' })}>{t('dictation.model.cancel')}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
