/** Probe of the ChatGPT quota the Codex CLI uses. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CACHE_TTL_MS = 60_000;
function authPath() {
    return join(process.env.CODEX_AUTH_DIR ?? join(homedir(), '.codex'), 'auth.json');
}
/**
 * The sign-in `auth.json` holds, sorted before any request: a token that is missing, is not a JWT or
 * has expired would only earn a 401. Never refreshed here — the refresh token rotates, and a probe
 * spending it would sign the CLI out; the CLI renews its own session on its next run.
 *
 * Only the file is read. With `cli_auth_credentials_store = "keyring"` (or `auto` with a working
 * keyring) the CLI keeps the session in the OS store under a key derived from its CODEX_HOME and
 * deletes `auth.json`; Rooks's missions run on their own CODEX_HOME and link this file, so they
 * cannot use such a session either (`inspectCodexAuth` gives the same advice).
 *
 * @returns {{ state: 'ok', accessToken: string, accountId: string } | { state: 'missing' | 'malformed' | 'expired' }}
 */
function readAuth(file, now = Date.now()) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        return { state: error?.code === 'ENOENT' ? 'missing' : 'malformed' };
    }
    const accessToken = raw?.tokens?.access_token;
    const accountId = raw?.tokens?.account_id;
    if (typeof accessToken !== 'string' || !accessToken || typeof accountId !== 'string' || !accountId)
        return { state: 'missing' };
    const exp = jwtExpiry(accessToken);
    if (exp === undefined)
        return { state: 'malformed' };
    if (exp !== null && exp * 1000 <= now)
        return { state: 'expired' };
    return { state: 'ok', accessToken, accountId };
}
/**
 * `exp` of a JWT, read without verifying the signature (the server does that): `undefined` when the
 * token is not a JWT at all, `null` when it carries no numeric `exp`.
 */
function jwtExpiry(token) {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1])
        return undefined;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!claims || typeof claims !== 'object')
            return undefined;
        return Number.isFinite(claims.exp) ? claims.exp : null;
    }
    catch {
        return undefined;
    }
}
function normalizeWindow(raw) {
    if (!raw)
        return null;
    const utilization = Number(raw.used_percent);
    const resetAt = Number(raw.reset_at);
    if (!Number.isFinite(utilization) || utilization < 0 || utilization > 100 || !Number.isFinite(resetAt)) {
        return null;
    }
    return { utilization, resets_at: new Date(resetAt * 1000).toISOString() };
}
/**
 * The payload calls the windows "primary"/"secondary", without guaranteeing
 * their order. Their duration is the only stable identifier the CLI exposes.
 */
export function normalizeCodexUsage(raw) {
    const windows = {};
    for (const candidate of [raw.rate_limit?.primary_window, raw.rate_limit?.secondary_window]) {
        if (!candidate)
            continue;
        const seconds = Number(candidate.limit_window_seconds);
        const key = seconds <= 6 * 60 * 60 ? 'five_hour' : 'seven_day';
        windows[key] = normalizeWindow(candidate);
    }
    return { windows, extra: null };
}
async function requestUsage(auth, fetchImpl, rejected) {
    const response = await fetchImpl(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${auth.accessToken}`,
            'ChatGPT-Account-Id': auth.accountId,
            Accept: 'application/json',
        },
    });
    if (!response.ok) {
        // The body is the server's JSON, not something to show a tester (it is what they saw).
        await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403)
            throw rejected();
        throw new Error(`wham/usage ${response.status}`);
    }
    return normalizeCodexUsage(await response.json());
}
/**
 * The probe, with its caches. `runtime.usage` is the daemon's own (the typed "not signed in" error is
 * recognised by its `code`, never by identity), so a plugin does not carry a copy of it.
 *
 * @param {import('@rooks/sdk/provider').ProviderRuntime} runtime `ctx.provider.runtime`
 */
export function createCodexUsage(runtime) {
    const { isUsageNotSignedInError, UsageNotSignedInError } = runtime.usage;
    const hostSlot = { cache: null };
    /** One slot per account directory: the first account answered must never
     *  become every account's figure. */
    const accountSlots = new Map();
    /** What each sign-in asks for: a `codex login` on the host, the settings for an account. */
    const HOST = {
        missing: 'No Codex ChatGPT sign-in found; run `codex login` (`codex -c cli_auth_credentials_store=file login` if Codex keeps it in the OS keyring) and retry',
        stale: 'Codex session expired or unreadable; run `codex login` and retry',
    };
    const ACCOUNT = {
        missing: 'This subscription account is not signed in; sign it in from the settings',
        stale: 'The session of this subscription account is unreadable or was refused; sign it in again from the settings',
        // As for Claude: an account's next mission renews its token, so an expired one is a gap in the gauge, not a sign-out.
        expired: 'The session of this subscription account expired; the next mission on it renews it',
    };
    /** Missing, malformed, expired or refused: a sign-in to ask for, and no request for a known no. */
    async function probe(file, messages, fetchImpl) {
        const auth = readAuth(file);
        if (auth.state === 'expired' && messages.expired)
            throw new Error(messages.expired);
        if (auth.state !== 'ok')
            throw new UsageNotSignedInError(auth.state === 'missing' ? messages.missing : messages.stale);
        return requestUsage(auth, fetchImpl, () => new UsageNotSignedInError(messages.stale));
    }
    async function getCodexUsage(opts = {}) {
        return cachedProbe(hostSlot, opts.force, () => probe(authPath(), HOST, opts.fetchImpl ?? fetch));
    }
    /**
     * Usage of a subscription account (TODO #330): its own `auth.json` and
     * nothing else, neither `CODEX_AUTH_DIR` nor `~/.codex`, which are the host's
     * sign-in.
     */
    async function getCodexAccountUsage(configDir, opts = {}) {
        const key = resolve(configDir);
        let slot = accountSlots.get(key);
        if (!slot) {
            slot = { cache: null };
            accountSlots.set(key, slot);
        }
        return cachedProbe(slot, opts.force, () => probe(join(key, 'auth.json'), ACCOUNT, opts.fetchImpl ?? fetch));
    }
    /** Drop every cached probe, so a test or a later sign-in starts fresh. */
    function resetCodexUsageCache() {
        hostSlot.cache = null;
        accountSlots.clear();
    }
    async function cachedProbe(slot, force, load) {
        const now = Date.now();
        const cache = slot.cache;
        if (!force && cache && now - cache.at < CACHE_TTL_MS) {
            if ('err' in cache)
                throw new Error(cache.err);
            return cache.data;
        }
        try {
            const data = await load();
            slot.cache = { at: now, data };
            return data;
        }
        catch (error) {
            // A missing sign-in stays typed and uncached: it ends with a sign-in,
            // not with a timer.
            if (isUsageNotSignedInError(error))
                throw error;
            const message = error.message;
            slot.cache = { at: now - (CACHE_TTL_MS - 10_000), err: message };
            throw error;
        }
    }
    return { getCodexUsage, getCodexAccountUsage, resetCodexUsageCache };
}
