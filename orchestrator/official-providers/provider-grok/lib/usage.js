/**
 * Read the shared weekly Grok subscription pool from the authenticated CLI
 * endpoint. The payload parser is adapted from 0xNyk/llmquota (MIT); only the
 * quota path is retained. Expired CLI credentials are refreshed through their
 * OIDC issuer and persisted back to the same store.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const CACHE_TTL_MS = 60_000;
function authPath() {
    if (process.env.GROK_AUTH_JSON)
        return resolve(process.env.GROK_AUTH_JSON);
    if (process.env.GROK_HOME)
        return join(resolve(process.env.GROK_HOME), 'auth.json');
    return join(homedir(), '.grok', 'auth.json');
}
function isOidc(scope, entry) {
    const mode = String(entry.auth_mode ?? entry.authMode ?? '').toLowerCase();
    if (mode !== 'oidc')
        return false;
    const explicit = String(entry.oidc_issuer ?? '').replace(/\/$/, '');
    if (scope === 'https://accounts.x.ai/sign-in')
        return !explicit || explicit.includes('x.ai');
    const scoped = scope.includes('::') ? scope.slice(0, scope.indexOf('::')) : '';
    return (explicit || scoped).includes('x.ai');
}
function readAuth() {
    try {
        const root = JSON.parse(readFileSync(authPath(), 'utf8'));
        const match = Object.entries(root).find(([scope, entry]) => isOidc(scope, entry));
        return match ? { root, scope: match[0], entry: match[1] } : null;
    }
    catch {
        return null;
    }
}
function numberInRange(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
        ? value
        : null;
}
export function parseGrokUsage(payload, now = Date.now()) {
    if (!payload || typeof payload !== 'object')
        return null;
    const root = payload;
    if (!root.config || typeof root.config !== 'object')
        return null;
    const config = root.config;
    if (!config.currentPeriod || typeof config.currentPeriod !== 'object')
        return null;
    const period = config.currentPeriod;
    if (period.type !== 'USAGE_PERIOD_TYPE_WEEKLY'
        || typeof period.start !== 'string' || typeof period.end !== 'string')
        return null;
    const start = Date.parse(period.start);
    const end = Date.parse(period.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end)
        return null;
    const usedPercent = config.creditUsagePercent === undefined
        ? 0
        : numberInRange(config.creditUsagePercent, 0, 100);
    if (usedPercent === null)
        return null;
    return { usedPercent, periodEnd: new Date(end).toISOString() };
}

/**
 * The probe, with its cache and its in-flight request. Built from the daemon's
 * runtime (`ctx.provider.runtime`): the OAuth refresh store and the "not signed in"
 * error are the daemon's, not a copy this plugin carries.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderRuntime} runtime
 */
export function createGrokUsage(runtime) {
  const { exchangeRefreshToken, expiryMs, isExpired, serializeRefresh, writeStoreAtomically } = runtime.oauth;
  const { isUsageNotSignedInError, UsageNotSignedInError } = runtime.usage;
  let cache = null;
  let usageRequest = null;
  const refreshSlot = { current: null };

  async function accessToken(auth, fetchImpl, now) {
      const current = typeof auth.entry.key === 'string' ? auth.entry.key : '';
      if (current && !isExpired(expiryMs(auth.entry.expires_at), now))
          return current;
      return serializeRefresh(refreshSlot, async () => {
          // A concurrent caller may have refreshed the store while this one waited.
          const latest = readAuth() ?? auth;
          const latestToken = typeof latest.entry.key === 'string' ? latest.entry.key : '';
          if (latestToken && !isExpired(expiryMs(latest.entry.expires_at), Date.now()))
              return latestToken;
          const refreshToken = typeof latest.entry.refresh_token === 'string' ? latest.entry.refresh_token : '';
          const issuer = typeof latest.entry.oidc_issuer === 'string'
              ? latest.entry.oidc_issuer.replace(/\/$/, '')
              : latest.scope.split('::')[0]?.replace(/\/$/, '');
          const clientId = typeof latest.entry.oidc_client_id === 'string' ? latest.entry.oidc_client_id : '';
          if (!refreshToken || !issuer || !clientId) {
              throw new Error('Grok OAuth token expired and refresh credentials are incomplete');
          }
          const discovery = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
              headers: { Accept: 'application/json' },
              signal: AbortSignal.timeout(8_000),
          });
          if (!discovery.ok)
              throw new Error(`Grok OIDC discovery ${discovery.status}`);
          const metadata = await discovery.json();
          if (typeof metadata.token_endpoint !== 'string' || !metadata.token_endpoint) {
              throw new Error('Grok OIDC discovery returned no token_endpoint');
          }
          const refreshed = await exchangeRefreshToken({
              tokenEndpoint: metadata.token_endpoint,
              refreshToken,
              clientId,
              fetchImpl,
          });
          latest.entry.key = refreshed.accessToken;
          latest.entry.expires_at = new Date(refreshed.expiresAt).toISOString();
          if (refreshed.refreshToken)
              latest.entry.refresh_token = refreshed.refreshToken;
          writeStoreAtomically(authPath(), latest.root, `${authPath()}.lock`);
          return refreshed.accessToken;
      });
  }
  async function fetchFresh(fetchImpl = fetch) {
      const auth = readAuth();
      if (!auth)
          throw new UsageNotSignedInError('No Grok OAuth session; run `grok login` and retry');
      const token = await accessToken(auth, fetchImpl, Date.now());
      const response = await fetchImpl('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
          headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              'X-XAI-Token-Auth': 'xai-grok-cli',
              'x-userid': typeof auth.entry.user_id === 'string' ? auth.entry.user_id : '',
          },
          signal: AbortSignal.timeout(8_000),
      });
      if (response.status === 401 || response.status === 403) {
          throw new Error(`Grok session rejected (${response.status}); run \`grok login\` and retry`);
      }
      if (!response.ok)
          throw new Error(`Grok billing probe failed (${response.status}); retry shortly`);
      const billing = parseGrokUsage(await response.json());
      if (!billing)
          throw new Error('Grok billing returned no current weekly quota');
      return {
          windows: {
              weekly: { utilization: billing.usedPercent, resets_at: billing.periodEnd },
          },
          extra: null,
      };
  }
  async function getGrokUsage(opts = {}) {
      const now = Date.now();
      if (!opts.force && cache && now - cache.at < CACHE_TTL_MS) {
          if (cache.usage)
              return cache.usage;
          throw new Error(cache.error ?? 'Grok usage unavailable');
      }
      if (usageRequest)
          return usageRequest;
      usageRequest = (async () => {
          try {
              const usage = await fetchFresh(opts.fetchImpl);
              cache = { at: Date.now(), usage };
              return usage;
          }
          catch (error) {
              if (isUsageNotSignedInError(error))
                  throw error;
              const message = error.message;
              cache = { at: Date.now() - 50_000, error: message };
              throw error;
          }
          finally {
              usageRequest = null;
          }
      })();
      return usageRequest;
  }

  return { getGrokUsage };
}
