/**
 * How a codex subscription account signs in (S7), in the shape a provider plugin writes
 * (`ProviderLoginDriver`): a PURE description the daemon plays (`backends/account-login.ts`).
 * Checked on codex 0.159.0. It was a branch of the daemon's own login flow, then an entry of
 * the product's table (`builtin-login.ts`); it is the plugin's now.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function plain(text) {
    return text.replace(ANSI_RE, '');
}
function sha(parts) {
    return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}
function readJson(file) {
    try {
        const value = JSON.parse(readFileSync(file, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }
    catch {
        return null;
    }
}
function moveCredential(from, to) {
    if (!existsSync(from))
        throw new Error('no credential to move');
    renameSync(from, to);
    if (process.platform !== 'win32')
        chmodSync(to, 0o600);
}
function str(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
function jwtPayload(token) {
    const part = token.split('.')[1];
    if (!part)
        return null;
    try {
        const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
        return value && typeof value === 'object' ? value : null;
    }
    catch {
        return null;
    }
}
/** codex: `codex login --device-auth` prints a URL and a one-time code; the person types the code on that page and the CLI polls. */
export const codexLoginDriver = {
    promptKind: 'device-code',
    // codex says 15 minutes.
    ttlMs: 15 * 60_000,
    // File storage: the account's sign-in has to be a file the missions'
    // `CODEX_HOME` can link to, never an OS keyring entry shared by all.
    // Unquoted, like the dialect's own `-c`: quotes are fragile through a `.cmd` shim.
    args: () => ['login', '--device-auth', '-c', 'cli_auth_credentials_store=file'],
    env: (dir, base) => ({ ...base, CODEX_HOME: dir, OPENAI_API_KEY: '', CODEX_API_KEY: '' }),
    parse(output) {
        const text = plain(output);
        const url = /https:\/\/\S+\/device\b\S*/.exec(text)?.[0];
        const code = url ? /\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\b/.exec(text.slice(text.indexOf(url) + url.length))?.[0] : undefined;
        return url && code ? { kind: 'device-code', url, code } : null;
    },
    async identity(dir) {
        const tokens = readJson(join(dir, 'auth.json'))?.['tokens'];
        const idToken = tokens && typeof tokens === 'object' ? str(tokens['id_token']) : null;
        const claims = idToken ? jwtPayload(idToken) : null;
        if (!claims)
            return null;
        const auth = claims['https://api.openai.com/auth'];
        const info = auth && typeof auth === 'object' ? auth : {};
        const account = str(info['chatgpt_account_id']);
        const user = str(info['chatgpt_user_id']) ?? str(info['user_id']) ?? str(claims['sub']);
        const email = str(claims['email']);
        if (!account || !user)
            return null;
        return { key: sha(['codex', account, user]), label: email ?? user };
    },
    install(staging, dest) {
        moveCredential(join(staging, 'auth.json'), join(dest, 'auth.json'));
    },
    async signOut(dir) {
        rmSync(join(dir, 'auth.json'), { force: true });
    },
};
