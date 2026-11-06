'use client';

import { useCallback, useEffect, useState } from 'react';

export type GptLiveStatus = { enabled: boolean; hasKey: boolean; secretName: string; model: string };

/** Fired after Settings changes the flag or the key, so the composer's button
 *  appears or leaves without a reload. */
export const GPT_LIVE_CHANGED = 'timon:gpt-live-changed';

export function notifyGptLiveChanged(): void {
  window.dispatchEvent(new Event(GPT_LIVE_CHANGED));
}

/** `null` while loading, and also when the module is off or the caller has no
 *  access: in every one of those cases there is nothing to show. */
export async function fetchGptLiveStatus(): Promise<GptLiveStatus | null> {
  try {
    const res = await fetch('/api/ui/gpt-live/status', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as GptLiveStatus;
  } catch {
    return null;
  }
}

export function useGptLiveStatus(): { status: GptLiveStatus | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<GptLiveStatus | null>(null);
  const refresh = useCallback(async () => { setStatus(await fetchGptLiveStatus()); }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => { void refresh(); };
    window.addEventListener(GPT_LIVE_CHANGED, onChange);
    return () => window.removeEventListener(GPT_LIVE_CHANGED, onChange);
  }, [refresh]);
  return { status, refresh };
}
