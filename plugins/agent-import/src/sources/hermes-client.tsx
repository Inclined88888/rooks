/**
 * The Hermes direct source in the import assistant: an occupant of the
 * `agentimport.source` socket. It asks the daemon whether Hermes lives on the
 * machine Rooks runs on (which may not be the browser's), lists its profiles,
 * and stages the checked ones through `hermes/stage`: no zip to make first.
 *
 * Nothing is shown when Hermes is not there, or when the account may not
 * import: the other sources stay the way in.
 */
import React from 'react';
import type { ComponentType, ReactNode } from 'react';
import * as ui from '@rooks/ui';
import { useAgentImport } from '../hooks.js';
import type { HermesDetectResponse, HermesProfileSummary, StageResponse } from '../contract.js';
import messages from '../messages.json';

const t = ui.createTranslator(messages);

const Button = ui.Button as ComponentType<{
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
}>;

/** The id the assistant records as the source of a Hermes import. */
export const HERMES_SOURCE_ID = 'hermes';

type Found = { label: string; profiles: HermesProfileSummary[] };

export function HermesSource({ detect, stage }: {
  /** `GET hermes`, or `null` when the daemon cannot say (refused, unreachable). */
  detect: () => Promise<HermesDetectResponse | null>;
  /** `POST hermes/stage` with the checked profile names. */
  stage: (profiles: string[]) => Promise<StageResponse>;
}) {
  const value = useAgentImport();
  const [found, setFound] = React.useState<Found | null>(null);
  const [checked, setChecked] = React.useState<ReadonlySet<string>>(new Set());
  const id = React.useId();

  React.useEffect(() => {
    let live = true;
    detect()
      .then((answer) => {
        if (!live || !answer?.found || answer.profiles.length === 0) return;
        setFound({ label: answer.label ?? '', profiles: answer.profiles });
        setChecked(new Set(answer.profiles.map((p) => p.name)));
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [detect]);

  if (!value || !found) return null;
  const chosen = found.profiles.map((p) => p.name).filter((name) => checked.has(name));
  const toggle = (name: string, on: boolean) => {
    setChecked((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-3" data-source={HERMES_SOURCE_ID}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{t('hermesSource.label')}</span>
        <span className="text-xs text-muted-foreground">{t('hermesSource.description', { label: found.label })}</span>
      </div>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2" disabled={value.busy}>
        <legend className="sr-only">{t('hermesSource.profiles')}</legend>
        {found.profiles.map((profile) => (
          <label key={profile.name} htmlFor={`${id}-${profile.name}`} className="flex items-center gap-2 text-sm">
            <input
              id={`${id}-${profile.name}`}
              type="checkbox"
              name={profile.name}
              className="h-4 w-4 accent-primary"
              checked={checked.has(profile.name)}
              onChange={(event) => toggle(profile.name, event.target.checked)}
            />
            {profile.displayName}
          </label>
        ))}
      </fieldset>
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={value.busy || chosen.length === 0}
          onClick={() => void value.submitStaged(HERMES_SOURCE_ID, () => stage(chosen))}
        >
          {t('hermesSource.import')}
        </Button>
      </div>
    </div>
  );
}
