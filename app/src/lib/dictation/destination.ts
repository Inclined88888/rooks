import { t } from '@/lib/i18n';
import { readDictationDecl, type DictationDecl, type DictationEgress } from './declaration';

export { readDictationDecl, type DictationDecl, type DictationEgress, type DictationEngineDecl } from './declaration';

/**
 * Where a dictation engine sends the voice (TODO #484, vault §3.4), as the
 * daemon read it in the plugin's manifest and published it on `/api/plugins`
 * (`PluginPublic.dictation`). Never from the engine itself: the engine is the
 * plugin's code, the manifest is what the operator was shown at install and
 * what a signature covers.
 *
 * The loader records the declarations of the plugins it mounts
 * (`recordDictationDeclarations`), before their browser halves register; an
 * engine whose plugin declares nothing for its id has no destination Timon
 * can name, and is never handed the microphone.
 */

export type VoiceDestination =
  /** The product's own engine: the desktop's, on this computer. */
  | { kind: 'device' }
  /** `egress: none`: the engine runs in the page and declares nothing leaves it. */
  | { kind: 'window' }
  /** `egress: daemon`: blocks of audio go to the daemon of the active machine. */
  | { kind: 'daemon' }
  | { kind: 'hosts'; hosts: readonly string[] }
  /** No declaration for this engine: Timon cannot say where the voice goes. */
  | { kind: 'undeclared' };

const PRODUCT_SCOPE = '@timon/';

type Declared = { label: string | null; decl: DictationDecl };

let declared = new Map<string, Declared>();
const listeners = new Set<() => void>();

function sameEgress(a: DictationEgress, b: DictationEgress): boolean {
  return egressFingerprint(a) === egressFingerprint(b);
}

function sameDeclarations(a: Map<string, Declared>, b: Map<string, Declared>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, next] of b) {
    const before = a.get(id);
    if (!before || before.label !== next.label || before.decl.engines.length !== next.decl.engines.length) return false;
    if (before.decl.models !== next.decl.models) return false;
    for (const [i, engine] of next.decl.engines.entries()) {
      const old = before.decl.engines[i]!;
      if (old.id !== engine.id || old.runtime !== engine.runtime || !sameEgress(old.egress, engine.egress)) return false;
    }
  }
  return true;
}

/**
 * Replaces what is known of every plugin's dictation block with the list the
 * daemon just served. A plugin absent from it (removed, refused) loses its
 * declaration, so its engine loses its destination.
 */
export function recordDictationDeclarations(plugins: ReadonlyArray<{ id: string; label?: string | null; dictation?: unknown }>): void {
  const next = new Map<string, Declared>();
  for (const plugin of plugins) {
    const decl = readDictationDecl(plugin.dictation);
    if (decl) next.set(plugin.id, { label: typeof plugin.label === 'string' ? plugin.label : null, decl });
  }
  if (sameDeclarations(declared, next)) return;
  declared = next;
  for (const listener of [...listeners]) listener();
}

export function subscribeDictationDeclarations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether `host` is one `declared` names: exactly, or under a `*.name` (which,
 *  as in a CSP source, covers subdomains only). */
function hostMatches(declared: string, host: string): boolean {
  if (!declared.startsWith('*.')) return declared === host;
  return host.endsWith(declared.slice(1)) && host.length > declared.length - 1;
}

/**
 * The plugin a `runtime: page` engine of which declares `host`, or `null`.
 * The window's Content-Security-Policy lists those hosts as the page loaded
 * (`lib/content-security-policy.ts`): an engine installed since then is
 * refused until a reload, and this is how the refusal is told apart from a
 * plugin reaching a host it never declared.
 */
export function pluginDeclaringHost(host: string): string | null {
  const name = host.toLowerCase();
  for (const [pluginId, { decl }] of declared) {
    for (const engine of decl.engines) {
      if (engine.runtime !== 'page' || !Array.isArray(engine.egress)) continue;
      if ((engine.egress as readonly string[]).some((declaredHost) => hostMatches(declaredHost, name))) return pluginId;
    }
  }
  return null;
}

/**
 * A `securitypolicyviolation` worth telling the user about: a connection the
 * window refused to a host a mounted plugin's page engine declares — the
 * plugin came after the page, and a reload lets it through. A host nobody
 * declared stays the browser console's business.
 */
export function refusedDeclaredHost(directive: string, blockedUri: string): { host: string; pluginId: string } | null {
  if (directive !== 'connect-src') return null;
  let url: URL;
  try { url = new URL(blockedUri); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'wss:') return null;
  const pluginId = pluginDeclaringHost(url.hostname);
  return pluginId ? { host: url.hostname, pluginId } : null;
}

/** The plugin's gallery label, else its id. */
export function dictationPluginLabel(pluginId: string): string {
  return declared.get(pluginId)?.label ?? pluginId;
}

export function isProductEngine(pluginId: string): boolean {
  return pluginId.startsWith(PRODUCT_SCOPE);
}

export function egressDestination(egress: DictationEgress): VoiceDestination {
  if (egress === 'none') return { kind: 'window' };
  if (egress === 'daemon') return { kind: 'daemon' };
  return { kind: 'hosts', hosts: egress };
}

/**
 * Where the voice of `engineId`, registered by `pluginId`, goes. A product
 * engine (`@timon/…`, an id no third-party manifest can take) is the
 * desktop's; any other engine is what its plugin's manifest declares for
 * that id, or `undeclared`.
 */
export function engineDestination(pluginId: string, engineId: string): VoiceDestination {
  if (isProductEngine(pluginId)) return { kind: 'device' };
  const engine = declared.get(pluginId)?.decl.engines.find((e) => e.id === engineId);
  return engine ? egressDestination(engine.egress) : { kind: 'undeclared' };
}

/** A stable form of an egress: two declarations that say the same thing compare equal. */
export function egressFingerprint(egress: DictationEgress): string {
  return typeof egress === 'string' ? egress : `hosts:${[...egress].sort().join(',')}`;
}

/** What a consent is given for; `null` when there is nothing to consent to (device) or nothing named (undeclared). */
export function destinationFingerprint(destination: VoiceDestination): string | null {
  switch (destination.kind) {
    case 'window': return 'none';
    case 'daemon': return 'daemon';
    case 'hosts': return egressFingerprint(destination.hosts);
    case 'device':
    case 'undeclared':
      return null;
  }
}

/**
 * "Where your voice goes", one sentence. `machine` names the daemon's
 * machine; without it the sentence says "the active machine" (the gallery
 * lists the active machine's plugins, so that is exact there).
 */
export function voiceDestinationLine(destination: VoiceDestination, machine?: string): string {
  switch (destination.kind) {
    case 'device': return t('dictation.destination.device');
    case 'window': return t('dictation.destination.window');
    case 'daemon': return machine ? t('dictation.destination.daemon', { machine }) : t('dictation.destination.daemonActive');
    case 'hosts': return t('dictation.destination.hosts', { hosts: destination.hosts.join(', ') });
    case 'undeclared': return t('dictation.destination.undeclared');
  }
}

/** The lines a plugin's sheet shows: one per engine, plus its models pack. */
export function declarationLines(decl: DictationDecl): string[] {
  const lines = decl.engines.map((engine) => {
    const line = voiceDestinationLine(egressDestination(engine.egress));
    return decl.engines.length > 1 ? t('dictation.destination.engineLine', { engine: engine.id, line }) : line;
  });
  if (decl.models) lines.push(t('dictation.destination.models'));
  return lines;
}
