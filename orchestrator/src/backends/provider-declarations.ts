/**
 * What a provider DECLARES about itself, as data the core reads
 * (`docs/PROVIDERS-SDK.md` § 6.2, C1 to C9; § 4 lists where the core names a
 * provider today and what each remedy is).
 *
 * The core never asks "is this claude?": it asks the provider what it declared.
 * This file is the vocabulary of those declarations and the pure helpers that read
 * them; the code that applies them (`host/binary-path.ts`, `host/isolation.ts`,
 * `equivalence.ts`…) lives with the part of the core it belongs to. Leaf on
 * purpose: the SDK publishes the types, and a provider's tests run the same
 * validation (`runtime.check.definitionProblems`) the daemon runs at registration.
 */

import { posix, win32 } from 'node:path';
import { otherBackendHomeDirProblem, protectedHomeDirProblem } from './credential-home-dirs.js';
import { BACKEND_CAPABILITIES } from './types.js';
import type { BackendCapabilities, LocalEnvPolicy, NormalizedEvent, SpanOp, SpanState } from './types.js';

/* ── C1 — the binary ─────────────────────────────────────────────────────── */

export const INSTALL_PLATFORMS = ['linux', 'darwin', 'win32'] as const;
export type InstallPlatform = (typeof INSTALL_PLATFORMS)[number];

export const PACKAGE_MANAGERS = ['apt', 'dnf', 'pacman', 'zypper', 'apk', 'brew', 'winget'] as const;
export type PackageManagerName = (typeof PACKAGE_MANAGERS)[number];

/**
 * How Rooks installs the binary on one OS. `none` is an honest blank: grok
 * and hermes-acp have no installer anyone can name, and a command
 * invented for them would fail in the user's terminal for a reason WE made up.
 */
export type ProviderInstallPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'npm'; readonly package: string }
  /** The vendor's standalone installer, as its documentation gives it. */
  | { readonly kind: 'script'; readonly posix?: string; readonly windows?: string }
  | { readonly kind: 'package'; readonly packages: Readonly<Partial<Record<PackageManagerName, string>>> };

/**
 * A build shipped by a desktop app next to the CLI: one folder per build under
 * `root`, the executable at `executable` inside it. The app deletes the old
 * folder on update, so a `host.binaries` pin into such a build goes stale on its
 * own and resolution falls back to detection instead of losing the CLI.
 */
export type ProviderDesktopBuild = {
  readonly platform: 'darwin' | 'win32';
  /** Template of the folder that holds the builds (see `expandDirectory`). */
  readonly root: string;
  /** Path of the executable inside a build's folder, one segment each. */
  readonly executable: readonly string[];
  /** `newest`: the most recently written executable first; `semver`: the highest version-named folder first. */
  readonly order: 'newest' | 'semver';
};

export const SERVICE_NEEDS = ['longLivedToken', 'graphicalSession'] as const;
export type ProviderServiceNeed = (typeof SERVICE_NEEDS)[number];

export type ProviderBinaryDeclaration = {
  /**
   * The names the program goes by, canonical first, aliases after: BARE names,
   * never a path (`cursor-agent`, `agent`). The manifest's `provider.binaries`
   * authorizes them at install; this lists what the daemon should look for.
   */
  readonly names: readonly string[];
  /** Install plan per OS; `any` applies where the OS has no entry. */
  readonly install?: Readonly<Partial<Record<InstallPlatform | 'any', ProviderInstallPlan>>>;
  /**
   * Folders to search beyond the PATH, per OS, where the vendor's installer puts
   * the binary and a daemon's PATH forgets it. Templates: a leading `~` is the
   * home folder, `${NAME}` an environment variable (the folder is dropped when
   * unset); separators are always `/`. `A|B` lists alternatives: the first one that expands.
   */
  readonly searchDirs?: Readonly<Partial<Record<InstallPlatform | 'any', readonly string[]>>>;
  readonly desktopBuilds?: readonly ProviderDesktopBuild[];
  /** What the service that runs the daemon must provide for this binary to work. */
  readonly serviceNeeds?: readonly ProviderServiceNeed[];
  /**
   * How the daemon tells this program from another one that goes by the same name (Cursor's `agent` and
   * grok's both land in `~/.local/bin`): checked before the program runs for a mission, a refusal naming
   * what it printed otherwise. Absent = the name is trusted, as before.
   */
  readonly identity?: ProviderBinaryIdentity;
};

/**
 * A program's own words about itself: what it prints for `args` must match `pattern`. Choose arguments
 * that only print (a version, a help line) — never one that signs in, opens a session or writes.
 */
export type ProviderBinaryIdentity = {
  /** Default `['--version']`. At most 4, plain words (no shell runs them). */
  readonly args?: readonly string[];
  /**
   * A regular expression (its source, at most 200 characters), tested on stdout and stderr together; `^` and `$` match a
   * line. A test that runs past 250 ms (a pattern that backtracks without end) is stopped and the program refused.
   */
  readonly pattern: string;
  /** How a person knows the right program, for the refusal: "Cursor's agent CLI". */
  readonly expected?: string;
};

export const BINARY_IDENTITY_MAX_PATTERN = 200;
const IDENTITY_ARG = /^[A-Za-z0-9][A-Za-z0-9._=:-]{0,63}$|^--?[A-Za-z0-9][A-Za-z0-9._=:-]{0,62}$/;

/** Why the identity declaration cannot be used, or null. `where` names the field for its author: the manifest carries a mirror of it. */
export function binaryIdentityProblem(identity: unknown, where = 'declares.binary.identity'): string | null {
  if (!isRecord(identity)) return `\`${where}\` must be \`{ pattern, args?, expected? }\``;
  if (identity.args !== undefined
    && (!stringList(identity.args) || identity.args.length > 4 || identity.args.some((a) => !IDENTITY_ARG.test(a)))) {
    return `\`${where}.args\` must be at most 4 plain arguments (\`--version\`, \`version\`)`;
  }
  if (typeof identity.pattern !== 'string' || identity.pattern === '' || identity.pattern.length > BINARY_IDENTITY_MAX_PATTERN) {
    return `\`${where}.pattern\` must be a regular expression of 1 to ${BINARY_IDENTITY_MAX_PATTERN} characters`;
  }
  try { new RegExp(identity.pattern); } catch { return `\`${where}.pattern\` is not a regular expression`; }
  // The refusal quotes it to the person deciding: one line, or it could pass for the daemon's own words.
  if (identity.expected !== undefined
    && (typeof identity.expected !== 'string' || identity.expected.length > 120 || /[\u0000-\u001f\u007f]/.test(identity.expected))) {
    return `\`${where}.expected\` must be a short sentence (one line, 120 characters at most)`;
  }
  return null;
}

/* ── What the provider says it has not checked on a real agent ─────────────── */

/**
 * The subjects a provider may mark as unverified: written from the vendor's documentation, its test
 * fixtures reconstructed rather than recorded. Closed list, so the screens can word each one.
 *   - `session`: the protocol as a whole (handshake, turns) — nothing ran against the real program;
 *   - `mcp`: Rooks's MCP servers handed through the session reach the agent's tools;
 *   - `permissions`: the agent's permission requests and their answers;
 *   - `sign-in`: how it signs in and what it says when signed out;
 *   - `models`: the model list and the switch between models;
 *   - `extension-requests`: the agent's own blocking requests (`extensionRequests`);
 *   - `credential-dirs`: the folders declared as its sign-in folders;
 *   - `binary-identity`: what its program prints about itself.
 */
export const UNVERIFIED_SUBJECTS = [
  'session', 'mcp', 'permissions', 'sign-in', 'models', 'extension-requests', 'credential-dirs', 'binary-identity',
] as const;
export type UnverifiedSubject = (typeof UNVERIFIED_SUBJECTS)[number];

/** One thing the provider has not seen work, and the sentence a person reads about it. */
export type ProviderUnverified = {
  readonly subject: UnverifiedSubject;
  /** One sentence, 200 characters at most: what is assumed, and on what basis. */
  readonly note: string;
};

export const UNVERIFIED_NOTE_MAX_CHARS = 200;

/* ── C4 — is the user signed in ──────────────────────────────────────────── */

export type ProviderAuthStatus = {
  readonly ok: boolean;
  /** One sentence for the screen: what was found, or what is missing. */
  readonly detail: string;
  /** The command that signs in, when there is one (`agent login`). */
  readonly signInCommand: string | null;
  /** Where the credentials were looked for, when the provider can say (`rooks doctor` prints it). */
  readonly path?: string;
  /** Where they were found: a file, or the environment the mission would get. */
  readonly source?: 'file' | 'environment' | null;
};

/* ── C11 — the models the CLI lists for the signed-in account ────────────── */

/**
 * The models a CLI itself lists for the account that is signed in, read from a local file it keeps (no
 * network: the catalogue is read synchronously, on the dispatch path). Slugs the profile does not name
 * yet, and the thinking levels each model accepts for THIS account. Null = the CLI has left nothing usable,
 * and the profile's own list serves. Only read for a profile that runs the CLI's own account, never for a
 * custom endpoint behind the same CLI.
 */
export type ProviderModelCache = {
  slugs(): readonly string[] | null;
  levels(): ReadonlyMap<string, readonly string[]> | null;
};

/* ── C12 — the wire protocol a provider speaks ───────────────────────────── */

/**
 * The protocols the "add a provider" form offers for an endpoint the user types in: the shape of the API
 * at the other end, which decides the CLI that talks to it. A provider that declares one is the CLI that
 * serves it.
 */
export const PROVIDER_PROTOCOLS = ['anthropic', 'openai-responses'] as const;
export type ProviderProtocol = (typeof PROVIDER_PROTOCOLS)[number];

/* ── C9 — the brand ──────────────────────────────────────────────────────── */

/** The logo of the provider, as inline SVG data. It is shown through an image (never injected into the page), so it can carry no script; the checks below refuse what would only look suspicious. */
export type ProviderBrand = {
  readonly svg: string;
};

export const MAX_BRAND_SVG_BYTES = 16 * 1024;

/* ── S7 — subscription accounts ──────────────────────────────────────────── */

/** What the person sees to sign an account in: paste a code the provider's page shows, or type a code on that page. */
export type ProviderLoginPrompt =
  | { readonly kind: 'paste-code'; readonly url: string }
  | { readonly kind: 'device-code'; readonly url: string; readonly code: string };

/** Who an account is signed in as. `key` is stable and opaque (a hash): two accounts of the same person collide on it. */
export type ProviderLoginIdentity = { readonly key: string; readonly label: string };

/** Runs a command of the CLI to its end, with a deadline; never throws. The daemon's: the process gets the system environment plus `env`. */
export type ProviderLoginRun = (
  args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs?: number,
) => Promise<{ readonly code: number; readonly stdout: string }>;

/**
 * How a CLI signs an account in, as a PURE description the daemon plays
 * (`backends/account-login.ts`): the CLI runs on the daemon's machine while the
 * person is in a browser, maybe on another one, so a callback to `localhost` would
 * never reach it. The CLI signs in in a staging folder; only once the identity is
 * checked (not a duplicate, the one expected on a reconnect) does `install` move the
 * credential into the account's folder. The daemon owns the process, the timers,
 * the staging folder, the rights and the audit trail; the provider owns what is
 * specific to its CLI.
 */
export type ProviderLoginDriver = {
  /** `paste-code`: the person pastes a code, the CLI reads it on its stdin. `device-code`: the person types a code on a page and the CLI polls. */
  readonly promptKind: ProviderLoginPrompt['kind'];
  /**
   * Whether the CLI keeps its sign-in outside the folder it is given (the macOS
   * keychain, under a name derived from that folder's path): the daemon then
   * signs in in the account's own folder, since a move would lose it. Default no.
   */
  readonly inPlace?: (platform: NodeJS.Platform) => boolean;
  /** The CLI's arguments; `expectedLabel` is who a reconnect expects (an e-mail), or null. */
  args(expectedLabel: string | null): string[];
  /** The environment that points the CLI at `dir`; `base` is the system whitelist, to extend. */
  env(dir: string, base: Readonly<Record<string, string>>): Record<string, string>;
  /** The prompt, once the CLI printed enough of it. */
  parse(output: string): ProviderLoginPrompt | null;
  /** Who `dir` is signed in as, or null when it is not. */
  identity(dir: string, run: ProviderLoginRun): Promise<ProviderLoginIdentity | null>;
  /** Moves the credential from `staging` into `dest` (the account's folder). Throws if there is none. */
  install(staging: string, dest: string): void;
  /** Signs `dir` out (only for a CLI that signs in in place). */
  signOut(dir: string, run: ProviderLoginRun): Promise<void>;
  /** How long a flow waits for the person. Default 10 minutes. */
  readonly ttlMs?: number;
};

export type ProviderAccountsDeclaration = {
  readonly login: ProviderLoginDriver;
};

/* ── The whole declaration ───────────────────────────────────────────────── */

export type ProviderDeclarations = {
  /** C1 */
  readonly binary?: ProviderBinaryDeclaration;
  /**
   * C2 — folders, relative to the home folder (`.grok`, `.config/opencode`), where
   * the CLI keeps its sign-in. A mission running on ANOTHER backend has them
   * masked; a mission on this one keeps them (`host/isolation.ts`).
   */
  readonly credentialDirs?: readonly string[];
  /**
   * C2 bis — names of variables of the daemon's environment that MOVE the folder where the CLI
   * keeps its sign-in (`CODEX_AUTH_DIR`, `GROK_AUTH_DIR`). The operator set them on purpose, and
   * the CLI's own error message tells people to; a mission must keep finding its sign-in there.
   * The folder is added to the places `scratch.link` takes a source from — for a provider shipped
   * in the release only, and never the home folder or a parent of it.
   */
  readonly credentialDirEnv?: readonly string[];
  /**
   * C6 — names of NON-secret variables of the daemon's environment copied into
   * the CLI's: `COPILOT_HOME`, `OPENCODE_CONFIG`, `HERMES_HOME`… The CLI needs
   * them to find its own sign-in; a name that looks like a credential is refused.
   */
  readonly passthroughEnv?: readonly string[];
  /** C5 — this provider can serve the daemon's own one-shot tasks (summaries, memory…), with this model. */
  readonly oneShot?: { readonly model: string };
  /**
   * C7 — which trace spans an event opens or closes: `'stream-json'` for a provider
   * that speaks claude's vocabulary (`runtime.events`), or its own function.
   * Absent = the provider is not traced.
   */
  readonly spans?: 'stream-json' | ((ev: NormalizedEvent, state: SpanState, eventId: number) => SpanOp[]);
  /**
   * S7 — this provider takes subscription accounts: several sign-ins of the same CLI,
   * each in a folder of its own, that missions run on (`<backend>@<account>`). Who
   * may use which account, and when, stays the core's (`MULTI-USER.md`); the provider
   * says how its CLI signs in.
   */
  readonly accounts?: ProviderAccountsDeclaration;
  /** C11 */
  readonly modelCache?: ProviderModelCache;
  /** C12 — the API protocols this provider's CLI can be pointed at (`anthropic`, `openai-responses`). */
  readonly protocols?: readonly ProviderProtocol[];
  /** C4 */
  authStatus?(env: Readonly<Record<string, string>>): ProviderAuthStatus | Promise<ProviderAuthStatus>;
  /** C9 */
  readonly brand?: ProviderBrand;
  /** Cf. `BackendCapabilities`: what this provider cannot do, whatever profile runs it. A key left out = true. */
  readonly capabilities?: Partial<BackendCapabilities>;
  /** Cf. `LocalEnvPolicy`: the variable names a user-added profile may set on this provider. Absent = none. */
  readonly localEnv?: LocalEnvPolicy;
  /** Does the CLI bring the hosted-account connectors on top of Rooks's MCP servers? Default no. */
  readonly hostedConnectors?: boolean;
  readonly browserToolsHint?: string;
  readonly permissionsHint?: string;
  /**
   * What this provider has not seen work on the real program (fixtures reconstructed from the vendor's
   * documentation): shown with the backend in the catalogue, so the person choosing it knows. One entry
   * per subject. Absent or empty = nothing claimed either way.
   */
  readonly unverified?: readonly ProviderUnverified[];
};

/* ── Path templates ──────────────────────────────────────────────────────── */

export type TemplateContext = {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
};

/**
 * `~/.opencode/bin` or `${LOCALAPPDATA}/OpenAI/Codex/bin` as a real folder of
 * `platform`, or null when a variable it needs is unset (the entry is then simply
 * not searched). The first segment is the root; the rest are joined with the OS's
 * own separator, so the same declaration serves every OS.
 */
export function expandDirectory(template: string, ctx: TemplateContext): string | null {
  // `A|B`: the first alternative that can be expanded (`${SCOOP}/shims|~/scoop/shims` — the
  // package manager's own root when the variable is set, its default otherwise).
  if (template.includes('|')) {
    for (const alternative of template.split('|')) {
      const folder = expandDirectory(alternative, ctx);
      if (folder) return folder;
    }
    return null;
  }
  const [first = '', ...rest] = template.split('/');
  let root: string | null;
  // A template that starts with `/` is an absolute folder of the OS (`/Applications/…`).
  if (first === '' && template.startsWith('/')) root = '/';
  else if (first === '~') root = ctx.home || null;
  else {
    const named = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(first);
    root = named ? (ctx.env[named[1]!] || null) : first;
  }
  if (!root) return null;
  if (rest.some((segment) => /^\$\{/.test(segment))) return null;
  // A Windows-style root joins with the Windows separator; a POSIX-looking one (a simulated machine) keeps `/`.
  const join = ctx.platform === 'win32' && win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32.join : posix.join;
  return join(root, ...rest.filter((segment) => segment !== ''));
}

/* ── Validation ──────────────────────────────────────────────────────────── */

const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A name that reads like a credential is never copied out of the daemon's environment. */
const SECRET_LOOKING = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|AUTH(?:ORIZATION)?$|COOKIE|SESSION)/i;
// public-name-ok: the ancestor's prefix is refused like Rooks's own
const FORBIDDEN_PASSTHROUGH_PREFIXES = ['ROOKS_', 'PKOS_'];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Why a folder template is not acceptable, or null. */
function templateProblem(template: unknown, where: string): string | null {
  if (typeof template !== 'string' || template === '') return `${where}: a folder template must be a non-empty string`;
  if (template.includes('|')) {
    for (const alternative of template.split('|')) { const why = templateProblem(alternative, where); if (why) return why; }
    return null;
  }
  if (template.includes('\\')) return `${where}: \`${template}\` uses a backslash; write \`/\` — the daemon joins with the OS's separator`;
  if (template.split('/').includes('..')) return `${where}: \`${template}\` goes up with \`..\``;
  const first = template.split('/')[0]!;
  const rooted = first === '~' || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(first) || template.startsWith('/') || /^[A-Za-z]:$/.test(first);
  if (!rooted) return `${where}: \`${template}\` must start with \`~\`, \`\${VARIABLE}\` or an absolute folder`;
  return null;
}

function installProblems(plan: unknown, where: string): string[] {
  if (!isRecord(plan)) return [`${where}: must be an object`];
  switch (plan.kind) {
    case 'none': return [];
    case 'npm':
      return typeof plan.package === 'string' && /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(plan.package)
        ? [] : [`${where}: \`package\` must be an npm package name`];
    case 'script':
      return (plan.posix === undefined || typeof plan.posix === 'string') && (plan.windows === undefined || typeof plan.windows === 'string')
        && (plan.posix !== undefined || plan.windows !== undefined)
        ? [] : [`${where}: a script plan needs \`posix\` and/or \`windows\`, as strings`];
    case 'package': {
      if (!isRecord(plan.packages) || Object.keys(plan.packages).length === 0) return [`${where}: \`packages\` must map a package manager to a package name`];
      return Object.entries(plan.packages).flatMap(([manager, name]) =>
        (PACKAGE_MANAGERS as readonly string[]).includes(manager) && typeof name === 'string' && name !== ''
          ? [] : [`${where}: \`${manager}\` is not a known package manager with a package name`]);
    }
    default:
      return [`${where}: \`kind\` must be 'none', 'npm', 'script' or 'package'`];
  }
}

/** What is wrong with the binary declaration (C1); empty = fine. */
export function binaryProblems(binary: unknown): string[] {
  if (!isRecord(binary)) return ['`declares.binary` must be an object'];
  const problems: string[] = [];
  const names = binary.names;
  if (!stringList(names) || names.length === 0 || names.length > 4) {
    problems.push('`declares.binary.names` must list 1 to 4 bare names (canonical first, then aliases)');
  } else if (names.some((n) => !BARE_NAME.test(n))) {
    problems.push('`declares.binary.names` must be BARE names (`cursor-agent`), never a path');
  }
  const perPlatform = (field: 'install' | 'searchDirs', check: (value: unknown, where: string) => string[]): void => {
    const table = binary[field];
    if (table === undefined) return;
    if (!isRecord(table)) { problems.push(`\`declares.binary.${field}\` must be an object keyed by OS`); return; }
    for (const [os, value] of Object.entries(table)) {
      if (os !== 'any' && !(INSTALL_PLATFORMS as readonly string[]).includes(os)) {
        problems.push(`\`declares.binary.${field}\`: \`${os}\` is not an OS (linux, darwin, win32, any)`);
        continue;
      }
      problems.push(...check(value, `\`declares.binary.${field}.${os}\``));
    }
  };
  perPlatform('install', installProblems);
  perPlatform('searchDirs', (value, where) => {
    if (!Array.isArray(value)) return [`${where}: must be a list of folder templates`];
    return value.flatMap((entry) => templateProblem(entry, where) ?? []);
  });
  if (binary.desktopBuilds !== undefined) {
    if (!Array.isArray(binary.desktopBuilds)) problems.push('`declares.binary.desktopBuilds` must be a list');
    else {
      binary.desktopBuilds.forEach((build, i) => {
        const where = `\`declares.binary.desktopBuilds[${i}]\``;
        if (!isRecord(build)) { problems.push(`${where}: must be an object`); return; }
        if (build.platform !== 'darwin' && build.platform !== 'win32') problems.push(`${where}: \`platform\` must be 'darwin' or 'win32'`);
        const root = templateProblem(build.root, `${where}.root`);
        if (root) problems.push(root);
        if (!stringList(build.executable) || build.executable.length === 0 || build.executable.some((s) => s === '' || s.includes('/') || s.includes('\\') || s === '..')) {
          problems.push(`${where}: \`executable\` must be the path inside a build, one plain segment each`);
        }
        if (build.order !== 'newest' && build.order !== 'semver') problems.push(`${where}: \`order\` must be 'newest' or 'semver'`);
      });
    }
  }
  if (binary.serviceNeeds !== undefined
    && (!Array.isArray(binary.serviceNeeds) || binary.serviceNeeds.some((n) => !(SERVICE_NEEDS as readonly unknown[]).includes(n)))) {
    problems.push(`\`declares.binary.serviceNeeds\` must list only ${SERVICE_NEEDS.map((n) => `'${n}'`).join(', ')}`);
  }
  if (binary.identity !== undefined) {
    const why = binaryIdentityProblem(binary.identity);
    if (why) problems.push(why);
  }
  return problems;
}

/** What is wrong with the unverified claims; empty = fine. */
export function unverifiedProblems(unverified: unknown): string[] {
  if (!Array.isArray(unverified)) return ['`declares.unverified` must be a list of `{ subject, note }`'];
  const problems: string[] = [];
  const seen = new Set<string>();
  unverified.forEach((entry, i) => {
    const where = `\`declares.unverified[${i}]\``;
    if (!isRecord(entry)) { problems.push(`${where}: must be \`{ subject, note }\``); return; }
    if (!(UNVERIFIED_SUBJECTS as readonly unknown[]).includes(entry.subject)) {
      problems.push(`${where}: \`subject\` must be one of ${UNVERIFIED_SUBJECTS.join(', ')}`);
    } else if (seen.has(entry.subject as string)) {
      problems.push(`${where}: \`${String(entry.subject)}\` is already listed`);
    } else seen.add(entry.subject as string);
    if (typeof entry.note !== 'string' || !entry.note.trim() || entry.note.length > UNVERIFIED_NOTE_MAX_CHARS) {
      problems.push(`${where}: \`note\` must be one sentence of 1 to ${UNVERIFIED_NOTE_MAX_CHARS} characters`);
    }
  });
  return problems;
}

/** Why a passthrough name is refused, or null. */
export function passthroughProblem(name: unknown): string | null {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) return `\`${String(name)}\` is not an environment variable name`;
  if (FORBIDDEN_PASSTHROUGH_PREFIXES.some((p) => name.toUpperCase().startsWith(p))) return `\`${name}\` belongs to Rooks`;
  if (SECRET_LOOKING.test(name)) {
    return `\`${name}\` reads like a credential: passthroughEnv copies NON-secret variables only (the CLI's own home or config folder). `
      + 'A credential goes through the profile\'s `env` resolver and the plugin\'s secret settings';
  }
  return null;
}

/** Why `dir` cannot be a credential folder of the provider `ownId` (or of a profile among `ownId`), or null (`host/isolation.ts` holds the policy). */
export function credentialDirProblem(dir: unknown, ownId?: string | readonly string[]): string | null {
  if (typeof dir !== 'string' || dir === '') return 'a credential folder must be a non-empty string';
  if (dir.startsWith('/') || dir.startsWith('~') || /^[A-Za-z]:/.test(dir) || dir.includes('\\')) {
    return `\`${dir}\` must be relative to the home folder, written with \`/\` (\`.grok\`, \`.config/opencode\`)`;
  }
  if (dir.split('/').some((s) => s === '..' || s === '' || s === '.')) return `\`${dir}\` must not contain \`..\` or empty segments`;
  return protectedHomeDirProblem(dir) ?? otherBackendHomeDirProblem(dir, ownId);
}

/** What is wrong with the accounts declaration (S7): a login driver is five functions and a kind of prompt. */
export function accountsProblems(accounts: unknown): string[] {
  if (!isRecord(accounts) || !isRecord(accounts.login)) return ['`declares.accounts` must be `{ login }`, the driver that signs an account in'];
  const login = accounts.login;
  const problems: string[] = [];
  if (login.promptKind !== 'paste-code' && login.promptKind !== 'device-code') problems.push("`declares.accounts.login.promptKind` must be 'paste-code' or 'device-code'");
  for (const key of ['args', 'env', 'parse', 'identity', 'install', 'signOut'] as const) {
    if (typeof login[key] !== 'function') problems.push(`\`declares.accounts.login.${key}\` must be a function`);
  }
  if (login.inPlace !== undefined && typeof login.inPlace !== 'function') problems.push('`declares.accounts.login.inPlace` must be a function of the platform');
  if (login.ttlMs !== undefined && !(Number.isInteger(login.ttlMs) && (login.ttlMs as number) >= 30_000 && (login.ttlMs as number) <= 60 * 60_000)) {
    problems.push('`declares.accounts.login.ttlMs` must be between 30 seconds and one hour, in milliseconds');
  }
  return problems;
}

/** What is wrong with the brand (C9): oversized, or SVG that is more than a picture. */
export function brandProblems(brand: unknown): string[] {
  if (!isRecord(brand) || typeof brand.svg !== 'string') return ['`declares.brand.svg` must be a string of SVG'];
  const svg = brand.svg;
  const problems: string[] = [];
  if (Buffer.byteLength(svg, 'utf8') > MAX_BRAND_SVG_BYTES) problems.push(`\`declares.brand.svg\` is over ${MAX_BRAND_SVG_BYTES} bytes`);
  if (!/^\s*<svg[\s>]/i.test(svg)) problems.push('`declares.brand.svg` must be one `<svg>` element');
  if (/<script|<foreignObject|<iframe|<object|<embed|\son[a-z]+\s*=|javascript:|data:text\/html|(?:href|src)\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(svg)) {
    problems.push('`declares.brand.svg` must be a plain picture: no script, no event handler, no embedded page and no external reference');
  }
  return problems;
}

/** What is wrong with the declarations of a provider; empty = coherent. */
export function declarationProblems(declares: unknown, ownId?: string): string[] {
  if (declares === undefined) return [];
  if (!isRecord(declares)) return ['`declares` must be an object'];
  const problems: string[] = [];
  if (declares.binary !== undefined) problems.push(...binaryProblems(declares.binary));
  if (declares.credentialDirs !== undefined) {
    if (!Array.isArray(declares.credentialDirs)) problems.push('`declares.credentialDirs` must be a list of folders relative to the home folder');
    else for (const dir of declares.credentialDirs) { const why = credentialDirProblem(dir, ownId); if (why) problems.push(`\`declares.credentialDirs\`: ${why}`); }
  }
  if (declares.credentialDirEnv !== undefined) {
    if (!Array.isArray(declares.credentialDirEnv) || declares.credentialDirEnv.length > 4) problems.push('`declares.credentialDirEnv` must be a list of at most 4 variable names');
    else for (const name of declares.credentialDirEnv) {
      if (typeof name !== 'string' || !ENV_NAME.test(name) || !/_(DIR|HOME)$/.test(name) || FORBIDDEN_PASSTHROUGH_PREFIXES.some((p) => name.toUpperCase().startsWith(p))) {
        problems.push(`\`declares.credentialDirEnv\`: \`${String(name)}\` must be a variable name ending in \`_DIR\` or \`_HOME\`, and not one of Rooks's`);
      }
    }
  }
  if (declares.passthroughEnv !== undefined) {
    if (!Array.isArray(declares.passthroughEnv)) problems.push('`declares.passthroughEnv` must be a list of variable names');
    else for (const name of declares.passthroughEnv) { const why = passthroughProblem(name); if (why) problems.push(`\`declares.passthroughEnv\`: ${why}`); }
  }
  if (declares.oneShot !== undefined && !(isRecord(declares.oneShot) && typeof declares.oneShot.model === 'string' && declares.oneShot.model !== '')) {
    problems.push('`declares.oneShot` must be `{ model }` with the model the daemon\'s own tasks should use');
  }
  if (declares.accounts !== undefined) problems.push(...accountsProblems(declares.accounts));
  if (declares.authStatus !== undefined && typeof declares.authStatus !== 'function') problems.push('`declares.authStatus` must be a function');
  if (declares.modelCache !== undefined
    && !(isRecord(declares.modelCache) && typeof declares.modelCache.slugs === 'function' && typeof declares.modelCache.levels === 'function')) {
    problems.push('`declares.modelCache` must be `{ slugs(), levels() }`, two synchronous readers of the CLI\'s own cache');
  }
  if (declares.protocols !== undefined
    && (!Array.isArray(declares.protocols) || declares.protocols.some((protocol) => !(PROVIDER_PROTOCOLS as readonly unknown[]).includes(protocol)))) {
    problems.push(`\`declares.protocols\` must list only ${PROVIDER_PROTOCOLS.map((protocol) => `'${protocol}'`).join(', ')}`);
  }
  if (declares.brand !== undefined) problems.push(...brandProblems(declares.brand));
  if (declares.capabilities !== undefined) {
    if (!isRecord(declares.capabilities)) problems.push('`declares.capabilities` must be an object');
    else for (const [key, flag] of Object.entries(declares.capabilities)) {
      if (!(BACKEND_CAPABILITIES as readonly string[]).includes(key)) problems.push(`\`declares.capabilities\`: unknown capability \`${key}\` (known: ${BACKEND_CAPABILITIES.join(', ')})`);
      else if (typeof flag !== 'boolean') problems.push(`\`declares.capabilities.${key}\` must be true or false`);
    }
  }
  if (declares.localEnv !== undefined) {
    const policy = declares.localEnv;
    if (!isRecord(policy) || !stringList(policy.names) || !stringList(policy.prefixes)) {
      problems.push('`declares.localEnv` must be `{ names: string[], prefixes: string[] }`');
    }
  }
  for (const flag of ['hostedConnectors'] as const) {
    if (declares[flag] !== undefined && typeof declares[flag] !== 'boolean') problems.push(`\`declares.${flag}\` must be true or false`);
  }
  for (const hint of ['browserToolsHint', 'permissionsHint'] as const) {
    if (declares[hint] !== undefined && typeof declares[hint] !== 'string') problems.push(`\`declares.${hint}\` must be a string`);
  }
  if (declares.unverified !== undefined) problems.push(...unverifiedProblems(declares.unverified));
  return problems;
}
