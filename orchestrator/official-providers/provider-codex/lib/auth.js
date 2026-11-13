import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export function codexAuthPath() {
    return join(resolve(process.env.CODEX_AUTH_DIR || join(homedir(), '.codex')), 'auth.json');
}
export function codexApiKey(env) {
    return env.CODEX_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || undefined;
}
/** A local presence check, not a provider request or a token-expiry verdict. */
export function inspectCodexAuth(env) {
    const path = codexAuthPath();
    const apiKeyReport = { ok: true, path, source: 'environment', detail: 'API key available to the mission.' };
    // CODEX_API_KEY explicitly overrides saved login in exec. A generic OpenAI
    // key must not silently move an existing subscription login onto API billing.
    if (env.CODEX_API_KEY?.trim())
        return apiKeyReport;
    try {
        if (statSync(path).isFile() && readFileSync(path, 'utf8').trim()) {
            return { ok: true, path, source: 'file', detail: 'Local credentials readable (not validated online).' };
        }
    }
    catch { /* Report only the path, never file contents or credential values. */ }
    if (env.OPENAI_API_KEY?.trim())
        return apiKeyReport;
    return { ok: false, path, source: null,
        detail: `Codex is not connected. Run codex login as the OS user running Rooks, then retry. No readable credentials at ${path} and no API key available to this agent. If you logged in elsewhere, set CODEX_AUTH_DIR to that credentials directory. For keyring-only login, use codex -c cli_auth_credentials_store=file login.` };
}
