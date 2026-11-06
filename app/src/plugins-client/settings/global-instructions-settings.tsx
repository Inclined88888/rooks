'use client';

import { useCallback, useEffect, useState } from 'react';

import { formatTokens } from '@/lib/agent-injections';
import { t } from '@/lib/i18n';
import { Body } from '../agent-injections/injection-detail';
import { readError } from '../agent-injections/use-agent-injections';

type Loaded = { content: string; path: string; max_chars: number };

/** A token count as the daemon estimates it everywhere else (~4 characters). */
const tokensOf = (text: string): string => formatTokens(Math.ceil(text.length / 4));

/**
 * The user's global instructions, in Settings → Missions: one markdown file the
 * daemon sends to every agent at each spawn. Read as markdown, edited through
 * the same editor as an injection; the daemon owns the file and the cap.
 */
export function GlobalInstructionsSettings() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch('/api/ui/global-instructions', { cache: 'no-store' });
        if (!alive) return;
        if (!res.ok) { setError(await readError(res)); return; }
        setError(null);
        setLoaded(await res.json() as Loaded);
      } catch (err) {
        if (alive) setError((err as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [version]);

  return (
    <section className="flex flex-col gap-3 py-4" aria-label={t('globalInstructions.title')}>
      <h3 className="text-[13px] font-medium">{t('globalInstructions.title')}</h3>
      <p className="max-w-2xl text-xs text-muted-foreground">{t('globalInstructions.description')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{t('globalInstructions.error', { message: error })}</p>}
      {!loaded && !error && <p className="text-xs text-muted-foreground">{t('globalInstructions.loading')}</p>}
      {loaded && (
        <div className="flex max-w-3xl flex-col gap-2">
          <p className="break-all text-[11px] text-muted-foreground">{t('globalInstructions.path', { path: loaded.path })}</p>
          <p className="text-[11px] tabular-nums text-muted-foreground">
            {t('globalInstructions.limit', { tokens: t('agentInjections.tokens', { n: tokensOf(loaded.content) }), max: loaded.max_chars })}
          </p>
          {!loaded.content.trim() && <p className="text-xs text-muted-foreground">{t('globalInstructions.empty')}</p>}
          <Body
            key={version}
            content={loaded.content}
            note={null}
            editableText={loaded.content}
            target={{ kind: 'global_instructions' }}
            onSaved={reload}
            fill
          />
        </div>
      )}
    </section>
  );
}
