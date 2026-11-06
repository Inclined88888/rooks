'use client';

/**
 * The official connectors: the remote MCP servers of their publishers,
 * connected in one click (docs/MCP-APPS.md), as the first section of the MCP
 * tab of Capabilities (`mcp.featured` slot). They are MCP servers like the
 * others, set apart only because they need no form. The section is the host
 * of every card: it lists the catalogue, connects (MCP server, then the
 * publisher's consent page or the key into the vault) and disconnects; each
 * card is painted by the `apps.card` slot. Its headings carry `data-toc`: the
 * tab's table of contents (`page.toc`) lists the section and its categories.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { useMcpTab } from '@/lib/mcp-tab-context';
import { AppCardHost } from '@/components/app-card/app-card';
import type { AppCardApp, AppCardCategory, AppCardLogo, AppCardStatus, AppCardValue } from '@/components/app-card/app-card-context';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { getLocale, t } from '@/lib/i18n';

type Localized = { en: string; fr: string };

/** An entry as `GET /api/mcp-apps` sends it (`AppView` of the daemon). */
export type AppView = {
  slug: string;
  name: string;
  publisher: string;
  category: AppCardCategory;
  tagline: Localized;
  description: Localized;
  examples: { en: string[]; fr: string[] };
  mcp: { url: string };
  auth: { type: 'oauth' } | { type: 'none' } | { type: 'key'; help_url: string; label: Localized };
  links: { website: string; privacy: string; terms: string };
  icon: { monogram: string; color: string; logo?: AppCardLogo & { source: string } };
  state: {
    connected: boolean;
    blocked: boolean;
    mcp_id: string;
    oauth_status: 'none' | 'pending' | 'authorized' | 'expired' | null;
  };
};

export const APP_CATEGORY_ORDER: readonly AppCardCategory[] = ['code', 'data', 'design', 'productivity', 'business'];

/** The catalogue's texts exist in English and French: any other language reads English. */
function catalogueLanguage(locale: string): 'en' | 'fr' {
  return locale === 'fr' || locale.startsWith('fr-') ? 'fr' : 'en';
}

/** The card's view of an entry, in the viewer's language. */
export function appCardApp(view: AppView, viewerLocale: string): AppCardApp {
  const locale = catalogueLanguage(viewerLocale);
  return {
    slug: view.slug,
    name: view.name,
    publisher: view.publisher,
    category: view.category,
    tagline: view.tagline[locale],
    description: view.description[locale],
    examples: view.examples[locale],
    url: view.mcp.url,
    auth: view.auth.type === 'key'
      ? { type: 'key', label: view.auth.label[locale], helpUrl: view.auth.help_url }
      : { type: view.auth.type },
    links: view.links,
    icon: view.icon.logo
      ? { monogram: view.icon.monogram, color: view.icon.color, logo: { viewBox: view.icon.logo.viewBox, paths: view.icon.logo.paths } }
      : { monogram: view.icon.monogram, color: view.icon.color },
    mcpId: view.state.mcp_id,
  };
}

/** What a card shows, from the daemon's state and the gesture under way. */
export function appStatus(view: AppView, busy: boolean): AppCardStatus {
  if (busy) return 'connecting';
  if (view.state.blocked) return 'blocked';
  if (!view.state.connected) return 'available';
  if (view.auth.type === 'oauth' && view.state.oauth_status !== 'authorized') return 'consent';
  return 'connected';
}

/** Connected connectors first, then the catalogue's order (by name), inside each category. */
export function connectorsInOrder(views: readonly AppView[]): AppView[] {
  return [...views].sort((a, b) => Number(b.state.connected) - Number(a.state.connected));
}

/** Search over what the card shows, accents and case ignored. */
export function appMatches(app: AppCardApp, query: string, categoryLabel: string): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return [app.name, app.publisher, app.tagline, app.description, categoryLabel].some((field) => fold(field).includes(q));
}

async function readError(r: Response): Promise<string> {
  const j = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
  return (j.reason || j.error || r.statusText || String(r.status)).slice(0, 160);
}

export function ConnectorsSection(): ReactElement | null {
  const query = useMcpTab()?.query ?? '';
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [vaultOff, setVaultOff] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [consentUrls, setConsentUrls] = useState<Readonly<Record<string, string>>>({});
  const locale = getLocale();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/mcp-apps', { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { apps: AppView[]; vault: boolean };
      if (!mounted.current) return;
      setApps(j.apps);
      setVaultOff(j.vault === false);
      setFailed(false);
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // The consent ends in another tab, or in the system browser on the desktop
    // app, where the broadcast below never arrives: a light poll catches it.
    // The tab around this section already says how the consent ended (toast
    // on the broadcast and on `?oauth=`): this one only reads the state again.
    const timer = setInterval(() => { void refresh(); }, 10_000);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel('timon-mcp-oauth');
      channel.onmessage = () => { void refresh(); };
    } catch { /* no BroadcastChannel: the poll covers it */ }
    return () => { mounted.current = false; clearInterval(timer); channel?.close(); };
  }, [refresh]);

  const setSlugBusy = (slug: string, on: boolean) => setBusy((prev) => {
    const next = new Set(prev);
    if (on) next.add(slug); else next.delete(slug);
    return next;
  });

  const connect = useCallback(async (view: AppView, key?: string): Promise<boolean> => {
    setSlugBusy(view.slug, true);
    try {
      const r = await fetch(`/api/ui/mcp-apps/${encodeURIComponent(view.slug)}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(key ? { key } : {}),
      });
      if (!r.ok) {
        toast.error(t('apps.toast.connectFailed', { name: view.name, error: await readError(r) }));
        return false;
      }
      const j = (await r.json()) as { next: 'oauth' | null };
      if (j.next !== 'oauth') {
        toast.success(t('apps.toast.connected', { name: view.name }));
        return true;
      }
      // `/apps` is a closed return path of the daemon: it redirects to this tab with the outcome.
      const start = await fetch(`/api/ui/mcp/${encodeURIComponent(view.state.mcp_id)}/oauth/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ return_path: '/apps' }),
      });
      const s = (await start.json().catch(() => ({}))) as { authorize_url?: string; error?: string };
      if (!start.ok || !s.authorize_url) {
        toast.error(t('apps.toast.connectFailed', { name: view.name, error: (s.error || start.statusText).slice(0, 160) }));
        return false;
      }
      const authorizeUrl = s.authorize_url;
      setConsentUrls((prev) => ({ ...prev, [view.slug]: authorizeUrl }));
      // `noopener` makes `window.open` return null even when the tab opened, so
      // its result says nothing: the card keeps a link to the page instead.
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      toast.info(t('apps.toast.consentOpened', { name: view.name }));
      return true;
    } catch (e) {
      toast.error(t('apps.toast.connectFailed', { name: view.name, error: String((e as Error).message || e).slice(0, 160) }));
      return false;
    } finally {
      setSlugBusy(view.slug, false);
      void refresh();
    }
  }, [refresh]);

  const disconnect = useCallback(async (view: AppView): Promise<boolean> => {
    const ok = await confirmAction({
      title: t('apps.confirm.disconnect', { name: view.name }),
      description: t('apps.confirm.disconnectDetail'),
      confirmLabel: t('apps.action.disconnect'),
      destructive: true,
    });
    if (!ok) return false;
    setSlugBusy(view.slug, true);
    try {
      const r = await fetch(`/api/ui/mcp-apps/${encodeURIComponent(view.slug)}`, { method: 'DELETE' });
      if (!r.ok) {
        toast.error(t('apps.toast.disconnectFailed', { name: view.name, error: await readError(r) }));
        return false;
      }
      setConsentUrls((prev) => { const next = { ...prev }; delete next[view.slug]; return next; });
      toast.success(t('apps.toast.disconnected', { name: view.name }));
      return true;
    } finally {
      setSlugBusy(view.slug, false);
      void refresh();
    }
  }, [refresh]);

  const groups = useMemo(() => {
    const out = new Map<AppCardCategory, { view: AppView; app: AppCardApp }[]>();
    for (const view of connectorsInOrder(apps ?? [])) {
      const app = appCardApp(view, locale);
      if (!appMatches(app, query, t(`apps.category.${view.category}`))) continue;
      const list = out.get(view.category) ?? [];
      list.push({ view, app });
      out.set(view.category, list);
    }
    return APP_CATEGORY_ORDER.filter((c) => out.has(c)).map((c) => ({ category: c, items: out.get(c)! }));
  }, [apps, query, locale]);

  if (failed && !apps) return <p className="mb-2 text-[12.5px] text-muted-foreground">{t('apps.loadFailed')}</p>;
  if (!apps || apps.length === 0) return null;
  // A search that finds no connector leaves the tab to the user's own servers.
  if (groups.length === 0) return null;

  return (
    <section aria-labelledby="mcp-connectors" className="mb-4">
      <h2
        id="mcp-connectors"
        data-toc={t('apps.title')}
        data-toc-count={groups.reduce((n, g) => n + g.items.length, 0)}
        className="m-0 text-[18px] font-semibold -tracking-[0.01em]"
      >
        {t('apps.title')}
      </h2>
      <p className="m-0 mt-0.5 text-[13px] text-muted-foreground">{t('apps.subtitle')}</p>
      <div className="mt-5 flex flex-col gap-6">
        {groups.map(({ category, items }) => (
          <div key={category} role="group" aria-labelledby={`mcp-connectors-${category}`}>
            <h3
              id={`mcp-connectors-${category}`}
              data-toc={t(`apps.category.${category}`)}
              data-toc-level="2"
              data-toc-count={items.length}
              className="m-0 mb-1.5 text-[13px] font-semibold"
            >
              {t(`apps.category.${category}`)} <span className="ml-1 font-normal tabular-nums text-muted-foreground">{items.length}</span>
            </h3>
            <div className="grid grid-cols-1 gap-x-8 gap-y-0.5 xl:grid-cols-2">
              {items.map(({ view, app }) => {
                const value: AppCardValue = {
                  app,
                  status: appStatus(view, busy.has(view.slug)),
                  consentUrl: consentUrls[view.slug] ?? null,
                  vaultOff,
                  connect: (key) => connect(view, key),
                  disconnect: () => disconnect(view),
                };
                return <AppCardHost key={view.slug} value={value} />;
              })}
            </div>
          </div>
        ))}
      </div>
      <p className="m-0 mt-4 max-w-[760px] text-[11.5px] leading-relaxed text-muted-foreground">{t('apps.footer')}</p>
    </section>
  );
}
