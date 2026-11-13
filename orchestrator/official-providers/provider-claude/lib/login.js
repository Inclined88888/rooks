
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAccountEnv } from './token.js';
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
function writePrivateJson(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
    if (process.platform !== 'win32')
        chmodSync(file, 0o600);
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

export const claudeLoginDriver = {
    promptKind: 'paste-code',

    inPlace: (platform) => platform === 'darwin',
    ttlMs: 10 * 60_000,
    args: (expected) => ['auth', 'login', '--claudeai', ...(expected ? ['--email', expected] : [])],
    env: (dir, base) => ({ ...base, ...claudeAccountEnv(dir) }),
    parse(output) {
        const url = /https:\/\/\S*oauth\/authorize\S*/.exec(plain(output))?.[0];
        return url ? { kind: 'paste-code', url } : null;
    },
    async identity(dir, run) {
        const result = await run(['auth', 'status', '--json'], claudeAccountEnv(dir));
        let status = null;
        try {
            status = JSON.parse(result.stdout);
        }
        catch {
            return null;
        }
        if (!status || status['loggedIn'] !== true)
            return null;
        const email = str(status['email']);
        const org = str(status['orgId']);
        if (!email)
            return null;
        return { key: sha(['claude', org ?? '', email.toLowerCase()]), label: email };
    },
    install(staging, dest) {
        moveCredential(join(staging, '.credentials.json'), join(dest, '.credentials.json'));


        const account = readJson(join(staging, '.claude.json'))?.['oauthAccount'];
        if (account !== undefined) {
            const target = join(dest, '.claude.json');
            writePrivateJson(target, { ...(readJson(target) ?? {}), oauthAccount: account });
        }
    },
    async signOut(dir, run) {
        await run(['auth', 'logout'], claudeAccountEnv(dir));
    },
};
