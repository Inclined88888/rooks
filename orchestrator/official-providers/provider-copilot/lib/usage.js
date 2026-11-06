/**
 * Account usage of the copilot dialect: the premium requests of the signed-in
 * Copilot seat, as the CLI itself reports them.
 *
 * The figure comes from `account.getQuota`, a method of the CLI's headless
 * JSON-RPC server (`copilot --headless --stdio`) — the documented public
 * interface the Copilot SDK drives (copilot-sdk `docs/features/
 * usage-and-billing.md`). The CLI resolves its own login (keychain or
 * `~/.copilot/config.json`): Timon reads no token and calls no
 * `copilot_internal` endpoint, which keeps `docs/BACKENDS-OUVERTS.md` § 5
 * intact.
 *
 * The method is marked experimental in the SDK, and no Copilot seat was
 * available to capture a live answer: every field is read defensively, and an
 * answer we cannot read is "unavailable", never a zero.
 *
 * No session is opened, so no premium request is spent and nothing lands in
 * the user's session history.
 */
/** Past this, the probe gives up and kills the process it started. */
const PROBE_TIMEOUT_MS = 20_000;
/**
 * Each reading starts a CLI process, and the chat polls every 30 s: a premium
 * request count moves turn by turn, not second by second.
 */
const CACHE_TTL_MS = 2 * 60_000;
/** A failed reading is retried sooner than a good one is refreshed, but never
 *  at the chat's polling rate — that would be a process every 30 s. */
const ERROR_TTL_MS = 60_000;
/** The quota Copilot bills prompts against. `chat` and `completions` are the
 *  IDE's allowances, which a CLI turn never draws on. */
const PREMIUM_QUOTA = 'premium_interactions';
/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;
function asRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
function finite(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Copilot's allowance renews on the first day of the month, UTC — used only
 *  when the CLI gives no `resetDate`. */
function nextMonthUtc(now) {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}
/**
 * `account.getQuota` result → `AccountUsage`, or `null` when it holds no
 * readable premium quota. An unlimited seat yields an empty `monthly` window:
 * a gauge would read "0 % used" where there is no ceiling at all.
 *
 * Overage stays out of `extra`: Copilot counts it in requests, and `extra`
 * is money.
 */
export function parseCopilotQuota(result, now = Date.now()) {
    const snapshots = asRecord(asRecord(result)?.quotaSnapshots);
    const premium = asRecord(snapshots?.[PREMIUM_QUOTA]);
    if (!premium)
        return null;
    const entitlement = finite(premium.entitlementRequests);
    if (premium.isUnlimitedEntitlement === true || entitlement === -1) {
        return { windows: { monthly: null }, extra: null };
    }
    const used = finite(premium.usedRequests);
    const remaining = finite(premium.remainingPercentage);
    let utilization = null;
    if (entitlement !== null && entitlement > 0 && used !== null)
        utilization = (used / entitlement) * 100;
    else if (remaining !== null)
        utilization = 100 - remaining;
    if (utilization === null)
        return null;
    const reset = typeof premium.resetDate === 'string' ? Date.parse(premium.resetDate) : NaN;
    return {
        windows: {
            monthly: {
                utilization: Math.max(0, Math.min(100, utilization)),
                resets_at: Number.isFinite(reset) ? new Date(reset).toISOString() : nextMonthUtc(now),
            },
        },
        extra: null,
    };
}
/** One JSON-RPC message in the `Content-Length` framing the headless server
 *  speaks (the vscode-jsonrpc one, not ACP's newline-delimited lines). */
export function encodeFrame(message) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}
/**
 * Accumulates stdout and yields each complete message. The length counts
 * BYTES: slicing a decoded string would cut a multi-byte character in two and
 * shift every frame after it.
 */
export class FrameReader {
    buffer = Buffer.alloc(0);
    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const out = [];
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1)
                break;
            const header = this.buffer.subarray(0, headerEnd).toString('ascii');
            const length = /Content-Length:\s*(\d+)/i.exec(header);
            if (!length) {
                // Not a frame header (a stray log line): drop it and resynchronise.
                this.buffer = this.buffer.subarray(headerEnd + 4);
                continue;
            }
            const start = headerEnd + 4;
            const end = start + Number(length[1]);
            if (this.buffer.length < end)
                break;
            const body = this.buffer.subarray(start, end).toString('utf8');
            this.buffer = this.buffer.subarray(end);
            try {
                out.push(JSON.parse(body));
            }
            catch { /* unreadable frame, skipped */ }
        }
        return out;
    }
}
/**
 * The probe, with its cache and its in-flight requests. Built from `ctx.provider`: the process is the
 * daemon's (`binary.converse`: declared program, system whitelist plus the profile's own, a deadline,
 * stopped with its tree — a `.cmd` shim on Windows included) and the "not signed in" error is its own.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderServices} services
 */
export function createCopilotUsage(services) {
    const { UsageNotSignedInError, isUsageNotSignedInError } = services.runtime.usage;
    const cache = new Map();
    const inFlight = new Map();
    /**
     * Asks the CLI for the account's quota: `connect` (the handshake, tolerated
     * when an older CLI lacks it), `auth.getStatus`, then `account.getQuota`.
     */
    async function probe(env) {
        const conversation = await services.binary.converse('copilot', ['--headless', '--stdio', '--no-auto-update'], { env, timeoutMs: PROBE_TIMEOUT_MS });
        return new Promise((resolve, reject) => {
            let settled = false;
            const reader = new FrameReader();
            const finish = (err, result) => {
                if (settled)
                    return;
                settled = true;
                void conversation.stop();
                if (err)
                    reject(err);
                else
                    resolve(result);
            };
            void conversation.exited.then(({ code }) => finish(new Error(`copilot --headless exited (${code ?? 'signal'})`)));
            const send = (id, method, params) => {
                conversation.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
            };
            conversation.onData((chunk) => {
                for (const raw of reader.push(Buffer.from(chunk))) {
                    const msg = asRecord(raw);
                    if (!msg)
                        continue;
                    const error = asRecord(msg.error);
                    if (msg.id === 1) {
                        // Whatever `connect` answers, the two methods we need are older than
                        // it; only the protocol version check is skipped.
                        send(2, 'auth.getStatus', {});
                    }
                    else if (msg.id === 2) {
                        if (error)
                            return finish(new Error('copilot --headless could not report its sign-in state'));
                        if (asRecord(msg.result)?.isAuthenticated !== true) {
                            return finish(new UsageNotSignedInError('No Copilot CLI session; run `copilot login` and retry'));
                        }
                        send(3, 'account.getQuota', {});
                    }
                    else if (msg.id === 3) {
                        // The provider's error text may carry request ids: only the kind of
                        // failure is kept.
                        if (error) {
                            return finish(new Error(error.code === METHOD_NOT_FOUND
                                ? 'this Copilot CLI does not report its quota; update it and retry'
                                : 'Copilot quota unavailable; retry shortly'));
                        }
                        return finish(null, msg.result);
                    }
                }
            });
            send(1, 'connect', {});
        });
    }
    async function fetchFresh(env) {
        const usage = parseCopilotQuota(await probe(env));
        if (!usage)
            throw new Error('Copilot reported no premium request quota');
        return usage;
    }
    /**
     * The account's premium request usage. Throws `UsageNotSignedInError` when
     * the CLI holds no login, a generic error when it cannot answer. Both are
     * cached like a success: each call is a process start.
     */
    async function getCopilotUsage(env = {}, opts = {}) {
        const key = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
        const now = opts.now ?? Date.now();
        const cached = cache.get(key);
        if (!opts.force && cached) {
            const ttl = cached.usage ? CACHE_TTL_MS : ERROR_TTL_MS;
            if (now - cached.at < ttl) {
                if (cached.usage)
                    return cached.usage;
                throw cached.error ?? new Error('Copilot usage unavailable');
            }
        }
        const pending = inFlight.get(key);
        if (pending)
            return pending;
        const request = (async () => {
            try {
                const usage = await fetchFresh(env);
                cache.set(key, { at: now, usage });
                return usage;
            }
            catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                cache.set(key, { at: now, error: isUsageNotSignedInError(err) ? err : new Error(err.message) });
                throw err;
            }
            finally {
                inFlight.delete(key);
            }
        })();
        inFlight.set(key, request);
        return request;
    }
    return { getCopilotUsage };
}
