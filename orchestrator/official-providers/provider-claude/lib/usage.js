import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
/** Account gauges share the daemon's OAuth and error vocabulary; refresh never touches the login keychain. */
const instances = new WeakMap();
export function createClaudeUsage(services, token) {
 if (instances.has(services)) return instances.get(services);
 const { isUsageNotSignedInError, UsageNotSignedInError } = services.runtime.usage;
 const { exchangeRefreshToken, expiryMs, hhmm, isExpired, serializeRefresh, writeStoreAtomically } = services.runtime.oauth;
 const { readClaudeToken } = token;






const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CACHE_TTL_MS = 60_000;
/** After a 429 the usage endpoint is left alone this long, unless its Retry-After says otherwise
 *  (within 1 min .. 1 h): asking again while it refuses only prolongs the refusal. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;
const RETRY_AFTER_MIN_MS = 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** How old the last good figures may be to stand in for a rate-limited probe. */
const STALE_MAX_MS = 30 * 60_000;
const hostProbe = { cache: null, request: null, last: null, blockedUntil: 0, blockedErr: null };

const accountProbes = new Map();

function resetClaudeUsageCache() {
    hostProbe.cache = null;
    hostProbe.request = null;
    hostProbe.last = null;
    hostProbe.blockedUntil = 0;
    hostProbe.blockedErr = null;
    accountProbes.clear();
}
const refreshSlot = { current: null };
function credentialsPath() {
    const dir = process.env.CLAUDE_CONFIG_DIR
        ? resolve(process.env.CLAUDE_CONFIG_DIR)
        : join(homedir(), '.claude');
    return join(dir, '.credentials.json');
}
function readCredentials() {
    return readCredentialsAt(credentialsPath());
}
function readCredentialsAt(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}

function keychainOauth(raw) {
    if (!raw)
        return null;
    const text = /^(?:[0-9a-f]{2})+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : raw;
    try {
        const oauth = JSON.parse(text).claudeAiOauth;
        return oauth && typeof oauth === 'object' ? oauth : null;
    }
    catch {
        return null;
    }
}
/** The access token of `oauth` with its expiry, or null when it is missing or expired. */
function liveAccess(oauth) {
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    const expiresAt = expiryMs(oauth?.expiresAt);
    return accessToken && !isExpired(expiresAt) ? { accessToken, expiresAt } : null;
}
async function readToken(fetchImpl = fetch, readKeychain = () => services.osCredentials.read('Claude Code-credentials'), platform = process.platform) {
    const fromEnv = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (fromEnv && fromEnv.trim())
        return fromEnv.trim();
    const credentials = readCredentials();
    const oauth = credentials?.claudeAiOauth;
    // On macOS the CLI keeps its session in the login keychain and leaves an old
    // `.credentials.json` behind: the keychain must win, or the probe keeps refreshing a
    // refresh token the CLI rotated away long ago (invalid_grant forever). `null` off macOS.
    const fromKeychain = keychainOauth(await readKeychain());
    const live = [liveAccess(oauth), liveAccess(fromKeychain)]
        .filter((candidate) => candidate !== null)
        .sort((a, b) => b.expiresAt - a.expiresAt);
    if (live.length)
        return live[0].accessToken;
    // Never rotate a refresh token from here on macOS: the CLI reads the keychain there, and a
    // token shared with it would sign the CLI out. Not even when the keychain answered `null`,
    // which may be a refused prompt or a timeout, remembered for a minute.
    if (platform === 'darwin' || fromKeychain || !credentials || !oauth) {
        const longLived = await readClaudeToken();
        if (longLived)
            return longLived;
        // Typed as signed out: the probe cannot renew it, only the CLI can, so the gauge must say
        // "not signed in" with the way back instead of reading as an outage (TODO #487).
        if (holdsSession(fromKeychain) || holdsSession(oauth))
            throw new UsageNotSignedInError('Claude Code session expired; run `claude` once to renew it and retry');
        if (fromKeychain)
            throw new UsageNotSignedInError('Claude Code is signed out; run `claude`, then `/login`, and retry');
        return longLived;
    }
    return refreshStored(credentialsPath(), refreshSlot, credentials, fetchImpl);
}

/**
 * Renews the access token kept in `file` with its refresh token, and writes the rotated pair back
 * under the CLI's own lock: the CLI reads that file, so it keeps working on what the probe left.
 * Re-read first: a mission of the same sign-in may have renewed it a moment ago.
 */
function refreshStored(file, slot, fallback, fetchImpl) {
    return serializeRefresh(slot, async () => {
        const latest = readCredentialsAt(file) ?? fallback;
        const latestOauth = latest?.claudeAiOauth ?? fallback?.claudeAiOauth;
        if (!latest || !latestOauth || typeof latestOauth !== 'object')
            throw new UsageNotSignedInError('No Claude Code OAuth session; run `/login` in the CLI and retry');
        const latestAccess = typeof latestOauth.accessToken === 'string' ? latestOauth.accessToken : '';
        if (latestAccess && !isExpired(expiryMs(latestOauth.expiresAt)))
            return latestAccess;
        const refreshToken = typeof latestOauth.refreshToken === 'string' ? latestOauth.refreshToken : '';
        const refreshExpiry = expiryMs(latestOauth.refreshTokenExpiresAt);
        if (!refreshToken || (refreshExpiry !== null && refreshExpiry <= Date.now())) {
            const suffix = refreshExpiry === null ? '' : ` (refresh token expired at ${hhmm(refreshExpiry)})`;
            throw new Error(`OAuth token expired; run the CLI login command again${suffix}`);
        }
        const scopes = Array.isArray(latestOauth.scopes)
            ? latestOauth.scopes.filter((scope) => typeof scope === 'string').join(' ')
            : undefined;
        let refreshed;
        try {
            refreshed = await exchangeRefreshToken({
                tokenEndpoint: TOKEN_URL,
                refreshToken,
                clientId: OAUTH_CLIENT_ID,
                scope: scopes || undefined,
                encoding: 'json',
                fetchImpl,
            });
        }
        catch (e) {
            // A refused grant is a signed-out CLI, not an outage: typed so the gauge says so and
            // never caches it, instead of echoing the token endpoint's JSON on every refresh.
            if (e instanceof Error && /invalid_grant|^token endpoint 401\b/.test(e.message)) {
                throw new UsageNotSignedInError('The Claude Code sign-in is no longer valid; run `claude`, then `/login`, and retry');
            }
            throw e;
        }
        latestOauth.accessToken = refreshed.accessToken;
        latestOauth.expiresAt = refreshed.expiresAt;
        if (refreshed.refreshToken)
            latestOauth.refreshToken = refreshed.refreshToken;
        if (refreshed.refreshTokenExpiresAt) {
            latestOauth.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt;
        }
        latest.claudeAiOauth = latestOauth;
        writeStoreAtomically(file, latest, `${file}.lock`);
        return refreshed.accessToken;
    });
}

async function fetchFresh(fetchImpl = fetch, readKeychain, platform) {
    const token = await readToken(fetchImpl, readKeychain, platform);
    if (!token) {
        throw new UsageNotSignedInError('No Claude Code OAuth session; run `/login` in the CLI and retry');
    }
    return requestUsage(token, fetchImpl);
}
async function requestUsage(token, fetchImpl) {
    const r = await fetchImpl(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!r.ok) {
        await r.text().catch(() => '');
        if (r.status === 401 || r.status === 403) {
            throw new Error(`Claude Code session rejected (${r.status}); run \`/login\` in the CLI and retry`);
        }
        const error = new Error(`oauth/usage ${r.status}`);
        if (r.status === 429) error.retryAfterMs = retryAfterMs(r.headers.get('retry-after'));
        throw error;
    }
    const j = (await r.json());
    return {
        five_hour: j.five_hour ?? null,
        seven_day: j.seven_day ?? null,
        extra_usage: j.extra_usage ?? null,
    };
}

async function getClaudeUsage(opts = {}) {
    const raw = await getRawUsage(opts);
    return {
        windows: { five_hour: raw.five_hour, seven_day: raw.seven_day },
        extra: raw.extra_usage,
    };
}
async function getRawUsage(opts = {}) {
    if (opts.force) services.osCredentials.invalidate('Claude Code-credentials');


    return cachedProbe(hostProbe, opts.force, () => fetchFresh(opts.fetchImpl, opts.readKeychain, opts.platform));
}
/** `Retry-After` in seconds or as an HTTP date, bounded; the default backoff when absent or unreadable. */
function retryAfterMs(header, now = Date.now()) {
    if (!header) return RATE_LIMIT_BACKOFF_MS;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (!Number.isFinite(ms)) return RATE_LIMIT_BACKOFF_MS;
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
}
/** The last good figures, while they are recent enough to stand in for a failed probe. */
function recentFigures(slot, now) {
    return slot.last && now - slot.last.at < STALE_MAX_MS ? slot.last.data : null;
}
async function cachedProbe(slot, force, load) {
    const now = Date.now();
    // Rate-limited: not even a person's refresh reaches the endpoint before the backoff ends.
    if (now < (slot.blockedUntil ?? 0)) {
        const figures = recentFigures(slot, now);
        if (figures) return figures;
        throw slot.blockedErr;
    }
    const cache = slot.cache;
    if (!force && cache && now - cache.at < CACHE_TTL_MS) {
        if ('err' in cache)
            throw cache.err;
        return cache.data;
    }
    if (slot.request)
        return slot.request;
    // `load` may throw synchronously: deferring it keeps the slot from holding a promise that already
    // settled, whose `finally` would have run before the assignment and left it rejected for good.
    const request = Promise.resolve()
        .then(load)
        .then((data) => {
            slot.cache = { at: Date.now(), data };
            slot.last = { at: Date.now(), data };
            slot.blockedUntil = 0;
            slot.blockedErr = null;
            return data;
        }, (e) => {
            if (isUsageNotSignedInError(e)) {
                // Never cached, and it supersedes an older cached failure that would else be replayed.
                slot.cache = null;
                slot.last = null;
                throw e;
            }
            const limited = typeof e?.retryAfterMs === 'number';
            if (limited) {
                slot.blockedUntil = Date.now() + e.retryAfterMs;
                slot.blockedErr = e;
            }
            // A rate limit is our own polling, not an outage: the last good figures stand in
            // for a while. A real failure (network, 5xx) still shows as one (TODO #632).
            const figures = limited ? recentFigures(slot, Date.now()) : null;
            slot.cache = { at: Date.now() - (CACHE_TTL_MS - 10_000), ...(figures ? { data: figures } : { err: e }) };
            if (figures) return figures;
            throw e;
        })
        .finally(() => {
            if (slot.request === request)
                slot.request = null;
        });
    slot.request = request;
    return request;
}

/** One refresh at a time per account, as for the host (`refreshSlot`). */
const accountRefreshSlots = new Map();

async function readAccountToken(configDir, fetchImpl, platform = process.platform) {
    const file = join(configDir, '.credentials.json');
    const credentials = readCredentialsAt(file);
    const oauth = credentials?.claudeAiOauth;
    const accessToken = typeof oauth?.accessToken === 'string' ? oauth.accessToken : '';
    if (!accessToken)
        throw new UsageNotSignedInError('This subscription account is not signed in; sign it in from the settings');
    if (!isExpired(expiryMs(oauth?.expiresAt)))
        return accessToken;
    // Renewed like the host's file, which the CLI of the account reads the same way: a gauge left
    // "stale" until a mission happened to run on the account told nothing. Never on macOS, where
    // the CLI keeps its session in the keychain and a rotated token would sign it out.
    if (platform === 'darwin' || typeof oauth.refreshToken !== 'string' || !oauth.refreshToken) {
        throw new Error('The session of this subscription account expired; the next mission on it renews it');
    }
    let slot = accountRefreshSlots.get(configDir);
    if (!slot) {
        slot = { current: null };
        accountRefreshSlots.set(configDir, slot);
    }
    return refreshStored(file, slot, credentials, fetchImpl);
}

async function getClaudeAccountUsage(configDir, opts = {}) {
    const key = resolve(configDir);
    let slot = accountProbes.get(key);
    if (!slot) {
        slot = { cache: null, request: null, last: null, blockedUntil: 0, blockedErr: null };
        accountProbes.set(key, slot);
    }
    const fetchImpl = opts.fetchImpl ?? fetch;
    const raw = await cachedProbe(slot, opts.force, async () => requestUsage(await readAccountToken(key, fetchImpl, opts.platform), fetchImpl));
    return {
        windows: { five_hour: raw.five_hour, seven_day: raw.seven_day },
        extra: raw.extra_usage,
    };
}

/** Whether the CLI holds a sign-in: a refresh token renews itself, an access token only until it expires. */
function holdsSession(oauth) {
    if (!oauth || typeof oauth !== 'object')
        return false;
    if (typeof oauth.refreshToken === 'string' && oauth.refreshToken)
        return true;
    return typeof oauth.accessToken === 'string' && !!oauth.accessToken && !isExpired(expiryMs(oauth.expiresAt));
}

/**
 * C4 — is this machine signed in to Claude Code? Read where the CLI itself looks, never
 * refreshed. `ok: false` covers a keychain this process cannot read: the claude CLI could
 * not read it from here either, and a fallback onto it would end on "Not logged in".
 */
async function claudeAuthStatus(env = {}) {
    const vars = Object.keys(env).length ? env : process.env;
    const value = (key) => (typeof vars[key] === 'string' ? vars[key].trim() : '');
    if (value('CLAUDE_CODE_OAUTH_TOKEN') || value('ANTHROPIC_API_KEY') || value('ANTHROPIC_AUTH_TOKEN')) {
        return { ok: true, detail: 'Claude credentials are set in the environment', signInCommand: null, source: 'environment' };
    }
    const configDir = value('CLAUDE_CONFIG_DIR');
    const file = configDir ? join(resolve(configDir), '.credentials.json') : credentialsPath();
    if (holdsSession(readCredentialsAt(file)?.claudeAiOauth)) {
        return { ok: true, detail: 'Claude Code session found', signInCommand: null, path: file, source: 'file' };
    }
    if (token.readClaudeToken()) {
        return { ok: true, detail: 'A long-lived Claude token is configured in Timon', signInCommand: null, source: 'environment' };
    }
    if (holdsSession(keychainOauth(await services.osCredentials.read('Claude Code-credentials')))) {
        return { ok: true, detail: 'Claude Code session found in the login keychain', signInCommand: null, source: 'file' };
    }
    return { ok: false, detail: 'Claude Code is not signed in: run `claude`, then `/login`', signInCommand: 'claude', path: file };
}

const api = { getClaudeUsage, getClaudeAccountUsage, resetClaudeUsageCache, claudeAuthStatus };
instances.set(services, api);
return api;
}
