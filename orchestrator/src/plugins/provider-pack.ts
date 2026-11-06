import { backendCollisionReason, parsePackBackend, toProfile } from '../backends/local-profiles.js';
import { registerPackProfile } from '../backends/registry.js';
import { openPluginKvValue } from '../secrets/plugins.js';
import type { PluginHost } from './context.js';
import type { PluginManifest } from './manifest.js';

export type PackProfileStatus = { index: number; id?: string; issue: string | null };

/** Values never enter manifests, status records or registry snapshots. */
export function mountProviderPack(manifest: PluginManifest, kv: PluginHost['kv']): {
  dispose: () => void;
  profiles: PackProfileStatus[];
} {
  const profiles: PackProfileStatus[] = [];
  const disposers: (() => void)[] = [];
  const secretSettings = manifest.settings.filter((s) => s.type === 'secret').map((s) => s.key);
  for (const [index, raw] of (manifest.backends ?? []).entries()) {
    const parsed = parsePackBackend(raw, secretSettings);
    if (!parsed.ok) {
      profiles.push({ index, issue: parsed.reason });
      continue;
    }
    const file = parsed.value;
    const refs = Object.entries(file.env ?? {}).flatMap(([envKey, value]) =>
      typeof value === 'object' && 'setting' in value ? [{ envKey, key: value.setting }] : []);
    const read = (): { env: Record<string, string>; issue: string | null } => {
      const env: Record<string, string> = {};
      for (const ref of refs) {
        try {
          const key = `@settings/${ref.key}`;
          const rawValue = kv.get(manifest.id, key);
          // Defaults are public manifest data, never a source of credentials.
          const value: unknown = rawValue === undefined ? undefined
            : JSON.parse(openPluginKvValue(manifest.id, key, rawValue, (sealed) => kv.set(manifest.id, key, sealed)));
          if (typeof value !== 'string' || !value.trim()) {
            return { env: {}, issue: `secret setting ${ref.key} is empty` };
          }
          env[ref.envKey] = value;
        } catch {
          return { env: {}, issue: `secret setting ${ref.key} cannot be read` };
        }
      }
      return { env, issue: null };
    };
    try {
      disposers.push(registerPackProfile(manifest.id, toProfile(file), refs.length ? {
        probe: () => read().issue,
        resolve: () => {
          const result = read();
          if (result.issue) throw new Error(result.issue);
          return result.env;
        },
      } : undefined));
      profiles.push({ index, id: file.id, issue: null });
    } catch {
      profiles.push({ index, id: file.id, issue: backendCollisionReason(file.id) });
    }
  }
  return { profiles, dispose: () => { for (const dispose of disposers.reverse()) dispose(); } };
}
