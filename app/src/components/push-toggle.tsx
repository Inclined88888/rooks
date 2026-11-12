'use client';

import { useCallback, useEffect, useState } from 'react';
import { BellRing, BellOff, Loader2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isZoneVisible, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * Web Push opt-in, per DEVICE.
 *
 * The browser refuses to create a subscription without a user gesture: there
 * is no subscribing silently on load, hence this explicit button. The state
 * shown is THIS device's (the subscription lives in the local browser), not a
 * global setting: the same account on two phones = two subscriptions.
 */

/** The VAPID public key arrives as base64url; `subscribe()` wants bytes.
 *  Return the ArrayBuffer rather than the view: `applicationServerKey` only
 *  accepts a BufferSource backed by an ArrayBuffer (never a SharedArrayBuffer). */
function urlBase64ToBytes(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}

/** A readable label to tell devices apart in the subscriptions table. */
function deviceLabel(): string {
  if (typeof navigator === 'undefined') return 'inconnu';
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Windows/i.test(ua)
    ? 'Windows'
    : /Mac OS X/i.test(ua)
    ? 'macOS'
    : /Linux/i.test(ua)
    ? 'Linux'
    : 'autre';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
    ? 'Opera'
    : /Brave/i.test(ua)
    ? 'Brave'
    : /Chrome\//.test(ua)
    ? 'Chrome'
    : /Firefox\//.test(ua)
    ? 'Firefox'
    : /Safari\//.test(ua)
    ? 'Safari'
    : 'navigateur';
  return `${os} · ${browser}`;
}

type State = 'loading' | 'unsupported' | 'disabled' | 'off' | 'on' | 'denied';

export function PushToggle() {
  // `web-push` module off: `/api/ui/push/config` no longer exists. The fetch
  // would fall back to the `disabled` state ("VAPID not configured"), a
  // message that would lie about the cause: here there is no push at all.
  const caps = useCapabilities();
  const [state, setState] = useState<State>('loading');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      // Insecure context (http:// outside localhost) or a browser without push:
      // the API is not even exposed, no point showing a button that will fail.
      setState('unsupported');
      return;
    }
    try {
      const r = await fetch('/api/ui/push/config', { cache: 'no-store' });
      const j = (await r.json()) as { enabled?: boolean; public_key?: string | null };
      if (!j.enabled || !j.public_key) {
        setState('disabled');
        return;
      }
      setPublicKey(j.public_key);
      if (Notification.permission === 'denied') {
        setState('denied');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? 'on' : 'off');
    } catch {
      setState('disabled');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'off');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBytes(publicKey),
        }));
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const res = await fetch('/api/ui/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          device_label: deviceLabel(),
        }),
      });
      if (!res.ok) {
        // The browser subscription exists but the server does not know it: undo
        // it, or the UI would show "enabled" for a dead channel.
        await sub.unsubscribe().catch(() => {});
        setMessage(t('pushToggle.serverRefused'));
        setState('off');
        return;
      }
      setState('on');
      setMessage(t('pushToggle.enabled'));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/ui/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setState('off');
      setMessage(t('pushToggle.disabledHere'));
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const r = await fetch('/api/ui/push/test', { method: 'POST', cache: 'no-store' });
      const j = (await r.json()) as { devices?: number; error?: string };
      setMessage(r.ok ? t('pushToggle.sent', { count: j.devices ?? 0 }) : (apiErrorMessage(j, t('pushToggle.failed'))));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const box = 'rounded-xl border border-border/60 bg-card/80 px-4 py-3';

  // After the hooks, never before.
  if (!isZoneVisible(caps, 'settings.push')) return null;

  if (state === 'loading') {
    return (
      <div className={cn(box, 'flex items-center gap-2 text-muted-foreground')}>
        <Loader2 className="size-4 animate-spin" />
        <span className="text-xs">{t('pushToggle.loading')}</span>
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div className={cn(box, 'text-muted-foreground')}>
        <p className="text-xs">{t('pushToggle.unsupported')}</p>
      </div>
    );
  }

  if (state === 'disabled') {
    return (
      <div className={cn(box, 'text-muted-foreground')}>
        <p className="text-xs">{t('pushToggle.disabled')}</p>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className={cn(box, 'text-muted-foreground')}>
        <p className="text-xs">{t('pushToggle.denied')}</p>
      </div>
    );
  }

  return (
    <div className={cn(box, 'flex flex-wrap items-center gap-2')}>
      <span className="flex items-center gap-2 text-xs">
        <span
          className={cn(
            'size-2 rounded-full',
            state === 'on' ? 'bg-emerald-400' : 'bg-muted-foreground/40',
          )}
        />
        {state === 'on' ? t('pushToggle.on') : t('pushToggle.off')}
      </span>
      <div className="ml-auto flex items-center gap-2">
        {state === 'on' ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={sendTest}
              className="flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <Send className="size-3" /> {t('pushToggle.test')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={disable}
              className="flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <BellOff className="size-3" /> {t('pushToggle.turnOff')}
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={enable}
            className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/15 px-2.5 py-1 text-[11.5px] text-primary transition-colors hover:bg-primary/25 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : <BellRing className="size-3" />}
            {t('pushToggle.turnOn')}
          </button>
        )}
      </div>
      {message && (
        <p className="w-full text-[11px] text-muted-foreground">{message}</p>
      )}
    </div>
  );
}
