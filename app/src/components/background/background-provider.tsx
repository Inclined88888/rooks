'use client';

import { createContext, useContext, useMemo, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStoredLayout } from '@/hooks/use-stored-layout';
import { useLayoutSeed } from '@/components/layout-seeds';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { BACKGROUND_SCOPE, readBackground, type BackgroundConfig } from './background-model';
import { useColorScheme } from '@/components/theme-provider';
import { BackgroundPattern } from './background-pattern';

type BackgroundContext = { background: BackgroundConfig; ready: boolean; update: (patch: Partial<BackgroundConfig>) => Promise<boolean> };
const Context = createContext<BackgroundContext | null>(null);
export function useBackground() {
  const value = useContext(Context);
  if (!value) throw new Error('BackgroundProvider missing');
  return value;
}
/** The wallpaper, for a surface that may render outside the provider (a test, a ghost chrome). */
export function useOptionalBackground(): BackgroundConfig | null {
  return useContext(Context)?.background ?? null;
}
export function BackgroundSurface({ background }: { background: BackgroundConfig }) {
  const { scheme } = useColorScheme();
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const photo = background.mode === 'photo' && background.photo && failedPhoto !== background.photo;
  const color = background.colors[scheme] ?? 'hsl(var(--background))';
  return <div className="pointer-events-none absolute inset-0 overflow-hidden" data-background-mode={background.mode} data-background-pattern={background.pattern} style={{ backgroundColor: color }}>
    {photo ? <>
      {/* Local authenticated image, intentionally outside Next's image cache. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={background.photo!} alt="" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailedPhoto(background.photo)} />
      <div data-background-veil className="absolute inset-0" style={{ backgroundColor: 'hsl(var(--background))', opacity: background.veil }} />
    </> : <BackgroundPattern pattern={background.mode === 'photo' ? 'none' : background.pattern} intensity={background.intensity} />}
  </div>;
}
function AccountBackground({ owner, children }: { owner: string | null; children: ReactNode }) {
  const stored = useStoredLayout(owner ? BACKGROUND_SCOPE : null, undefined, { cancelQueuedOnUnmount: true });
  // The seed is read directly here too, for the moment the owner is not
  // resolved yet: the scope is null then, so the hook holds nothing, while the
  // server already knows whose canvas this is — it read it with the session
  // cookie, which needs no owner to be resolved first.
  const seeded = useLayoutSeed(BACKGROUND_SCOPE);
  const background = useMemo(() => readBackground(stored.raw ?? seeded), [stored.raw, seeded]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return <Context.Provider value={{ background, ready: stored.ready, update: (patch) => stored.update(raw => readBackground({ ...readBackground(raw), ...patch })) }}>
    {mounted && createPortal(<div id="rooks-background" aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10"><BackgroundSurface background={background} /></div>, document.body)}
    {children}
  </Context.Provider>;
}
export function BackgroundProvider({ children }: { children: ReactNode }) {
  const { owner } = useWorkspaceLayout();
  return <AccountBackground key={owner ?? 'anonymous'} owner={owner}>{children}</AccountBackground>;
}
