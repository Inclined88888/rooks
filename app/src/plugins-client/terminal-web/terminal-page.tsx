'use client';

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { TerminalWorkspace } from '@/components/terminal/terminal-workspace';
import { useTouchKeyboard } from '@/components/terminal/use-touch-keyboard';
import { t } from '@/lib/i18n';
import { fetchTerminalStatus, openTerminalWindow, scopeFromKey, scopeKey } from '@/lib/terminal-web';
import { cn } from '@/lib/utils';

/**
 * Height left between the top of `el` and the top of the on-screen keyboard.
 * The layout viewport does not shrink when the keyboard opens on iOS: sized
 * in `dvh`, the prompt would sit under the keyboard. Null off touch devices.
 */
function useHeightAboveKeyboard(el: HTMLElement | null, enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled || !el) { setHeight(null); return; }
    const vv = window.visualViewport;
    const read = () => {
      const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      setHeight(Math.max(160, Math.floor(bottom - el.getBoundingClientRect().top - 8)));
    };
    read();
    vv?.addEventListener('resize', read);
    vv?.addEventListener('scroll', read);
    window.addEventListener('resize', read);
    return () => {
      vv?.removeEventListener('resize', read);
      vv?.removeEventListener('scroll', read);
      window.removeEventListener('resize', read);
    };
  }, [el, enabled]);
  return height;
}

/** Label of a scope key on the picker. */
function scopeName(key: string | null): string {
  const scope = scopeFromKey(key);
  if (!scope) return t('terminal.scopes.none');
  return scope.kind === 'project' ? scope.slug : scope.name;
}

/**
 * `/terminal`: the user's shells, full page — the natural home on a phone.
 * Shells belong to a project (or an agent without one): the picker lists
 * every scope that has shells, one strip of tabs at a time. `?project=`
 * preselects a project.
 */
export function TerminalPage(): ReactElement {
  const touch = useTouchKeyboard();
  const [scopes, setScopes] = useState<Array<string | null>>([null]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const project = new URLSearchParams(window.location.search).get('project');
    const preselected = project ? scopeKey({ kind: 'project', slug: project }) : null;
    setSelected(preselected);
    void fetchTerminalStatus().then((status) => {
      const keys = new Set<string | null>([null, preselected]);
      for (const s of status.sessions) keys.add(s.scope ?? null);
      setScopes([...keys]);
    }).catch(() => { /* the workspace below shows the error */ });
  }, []);
  const frame = useRef<HTMLDivElement>(null);
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => setFrameEl(frame.current), []);
  const height = useHeightAboveKeyboard(frameEl, touch);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="shrink-0 text-base font-semibold">{t('terminal.title')}</h1>
          <div className="flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label={t('terminal.scopes.label')}>
            {scopes.map((key) => (
              <button
                key={key ?? ''}
                type="button"
                role="tab"
                aria-selected={key === selected}
                onClick={() => setSelected(key)}
                className={cn(
                  'shrink-0 rounded-full px-2.5 py-1 text-xs transition-colors',
                  key === selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {scopeName(key)}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => openTerminalWindow()}
          className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground md:flex"
        >
          <PictureInPicture2 className="size-3.5" />
          {t('terminal.actions.popOut')}
        </button>
      </div>
      <div
        ref={frame}
        style={height ? { height, flex: 'none' } : undefined}
        className="min-h-0 flex-1 overflow-hidden rounded-xl bg-card ring-1 ring-border"
      >
        <TerminalWorkspace key={selected ?? ''} scope={scopeFromKey(selected)} showKeyBar={touch} />
      </div>
    </div>
  );
}
