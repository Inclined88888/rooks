/** Sealed provider-owned credentials, including a release's historical storage identity. */
import { z } from 'zod';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dbApi } from '../db.js';
import { TIMON_HOME } from '../paths.js';
import { isSealed } from '../secrets/box.js';
import { invalidateRedactionCache } from '../secrets/redact.js';
import { openWithVault, pluginKvIdentity, sealWithVault } from '../secrets/store.js';
import type { ProviderCredentialStore } from './provider-services.js';

const Spec = z.object({ store: z.string().min(1).max(160), key: z.string().startsWith('@settings/').max(160), marker: z.string().regex(/^[a-z][a-z0-9-]{0,100}$/) }).strict();
const Body = z.object({ token: z.string().min(1).max(8192) }).strict();

export function openProviderCredentialStore(input: { store: string; key: string; marker: string }): ProviderCredentialStore {
  const spec = Spec.parse(input);
  const identity = pluginKvIdentity(spec.store, spec.key);
  const marker = join(TIMON_HOME, 'run', spec.marker);
  const configured = (): boolean => dbApi.pluginKvGet(spec.store, spec.key) !== undefined;
  const read = (): string | null => {
    try {
      const raw = dbApi.pluginKvGet(spec.store, spec.key);
      return raw && isSealed(raw) ? openWithVault(raw, identity) : null;
    } catch { return null; }
  };
  const syncMarker = (): void => {
    try {
      if (configured()) {
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, 'configured\n', { mode: 0o600 });
      } else rmSync(marker, { force: true });
    } catch { /* A service hint cannot invalidate the saved credential. */ }
  };
  return {
    read,
    status: () => ({ configured: configured(), readable: read() !== null }),
    parseBody(body) {
      const parsed = Body.safeParse(body);
      return parsed.success ? parsed.data.token : null;
    },
    write(value) {
      // Validation is repeated here so callers other than HTTP have the same ceiling.
      const parsed = Body.safeParse({ token: value });
      if (!parsed.success) throw new Error('Invalid credential value');
      let envelope: string;
      try { envelope = sealWithVault(parsed.data.token, identity); }
      catch { throw new Error('The secrets vault is unavailable; the token was not saved.'); }
      dbApi.pluginKvSet(spec.store, spec.key, envelope);
      invalidateRedactionCache();
      syncMarker();
    },
    clear() {
      const existed = configured();
      dbApi.pluginKvDelete(spec.store, spec.key);
      invalidateRedactionCache();
      syncMarker();
      return existed;
    },
    syncMarker,
  };
}
