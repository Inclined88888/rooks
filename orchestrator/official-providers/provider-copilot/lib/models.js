/**
 * The models THIS Copilot account may use, asked of the CLI itself.
 *
 * Which models a Copilot seat reaches is decided by its organisation's policy
 * (GPT, Claude, Gemini — whatever the admin enabled), so a list written in the
 * product would be wrong for half the testers. The CLI has no command that
 * prints the list, but its Agent Client Protocol mode (`copilot --acp`, a
 * documented public interface) returns it when a session is opened: that is
 * the request the CLI itself makes to fill its `/model` menu. Verified on
 * 1.0.89: without a seat, `session/new` fails precisely on "Error loading
 * models" (403).
 *
 * No prompt is sent, so no premium request is spent. The probe is bounded in
 * time and always kills the process it started.
 */
/** Past this, the probe gives up and the static list stays in place (the daemon stops the process then). */
const PROBE_TIMEOUT_MS = 20_000;
/**
 * A successful answer is reused this long. An organisation's policy moves in
 * weeks, and every probe opens an (empty) session the CLI keeps in the user's
 * own history — the catalogue's 30-minute refresh would add 48 a day.
 */
const ANSWER_TTL_MS = 6 * 60 * 60 * 1000;
function asRecord(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
/**
 * The probe, with its cache. Built from `ctx.provider`: the process is the daemon's
 * (`binary.converse`: declared program, system whitelist plus the profile's own, a deadline,
 * stopped with its tree) and the list is read by the daemon's own reader.
 *
 * @param {import('@timon-ai/sdk/provider').ProviderServices} services
 */
export function createCopilotModels(services) {
    const answers = new Map();
    /**
     * Opens an ACP session on the CLI and returns the model ids it offers. Rejects
     * when the CLI is missing, not logged in, refuses the session, or answers
     * nothing in time — the caller then keeps serving its static list.
     *
     * @param {{ env?: Record<string, string> }} profile
     */
    async function discover(profile, now = Date.now()) {
        const env = profile?.env ?? {};
        const key = JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
        const cached = answers.get(key);
        if (cached && now - cached.at < ANSWER_TTL_MS)
            return cached.ids;
        const ids = await probe(env);
        answers.set(key, { ids, at: now });
        return ids;
    }
    async function probe(env) {
        const conversation = await services.binary.converse('copilot', ['--acp', '--no-auto-update'], { env, timeoutMs: PROBE_TIMEOUT_MS });
        return new Promise((resolve, reject) => {
            let settled = false;
            let buffer = '';
            const finish = (err, ids = []) => {
                if (settled)
                    return;
                settled = true;
                void conversation.stop();
                if (err)
                    reject(err);
                else
                    resolve(ids);
            };
            void conversation.exited.then(({ code }) => finish(new Error(`copilot --acp exited (${code ?? 'signal'})`)));
            const send = (id, method, params) => {
                conversation.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
            };
            conversation.onData((chunk) => {
                buffer += Buffer.from(chunk).toString('utf8');
                let nl;
                while ((nl = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line)
                        continue;
                    let msg;
                    try {
                        msg = asRecord(JSON.parse(line));
                    }
                    catch {
                        continue;
                    }
                    if (!msg)
                        continue;
                    if (msg.id === 1) {
                        if (msg.error)
                            return finish(new Error('copilot --acp refused initialize'));
                        send(2, 'session/new', { cwd: conversation.cwd, mcpServers: [] });
                    }
                    else if (msg.id === 2) {
                        // The error text of a refused session is the provider's, with request
                        // ids in it: we keep only that it was refused.
                        if (msg.error)
                            return finish(new Error('copilot --acp refused the session (not logged in, or no Copilot seat)'));
                        const ids = services.runtime.models.modelIdsFromSessionNew(msg.result);
                        return ids.length > 0 ? finish(null, ids) : finish(new Error('copilot --acp returned no model'));
                    }
                }
            });
            send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
        });
    }
    return { discover };
}
