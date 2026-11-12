/**
 * `rooks doctor` — what this machine can do.
 *
 * The diagnostic answers a precise question, asked on every fresh-machine
 * install: "what will work here, and what will be missing?". It doesn't fix
 * or change anything — it only looks.
 *
 * Capabilities are no longer computed here: since step 2.3 they come from
 * `host.capabilities()` (plan §3.5). The diagnostic keeps the DETAIL (resolved
 * binaries, docker reachable or not, graphical session) — what a human reads
 * to understand WHY a capability is missing — but the list that decides
 * module activation has a single source of truth: the host adapter.
 */
import { inheritEnvEnabled, systemEnv, secretsEnvFor } from './secrets/env.js';
import { mainAgentNameOrSeed, mainSeatState } from './main-agent.js';
import { mainAgentOnboardingPending } from './onboarding-main-agent.js';
import { listAgents } from './agent.js';
import { loadConfig } from './agent-config.js';
import { projectFromCwd } from './task-project.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, config } from './config/load.js';
import {
  installCommandFor,
  linuxRelease,
  readOsRelease,
  supervisorFor,
} from './host/machine.js';
import { getHost } from './host/index.js';
import { hasSystemd } from './host/systemd.js';
import { windowsServiceFiles } from './host/service-install.js';
import { resolveIsolation, sandboxSupported } from './host/isolation.js';
import { ROOKS_HOME } from './paths.js';
import { formatBytes, freeBytes, LOW_DISK_BYTES } from './storage-failure.js';
import { CATALOG } from './kernel/catalog.js';
import { degradation } from './kernel/degradation.js';
import { nodelessBackends, nodelessBackendText } from './host/launch-path.js';
import { binaryCandidates, findExecutableBinary, npmPrefixCandidates, pinnedBinaryCandidates, resolvePinnedBinary, type BinarySearchOptions } from './host/binary-path.js';
import { BUILTIN_API_KEY_PROVIDERS, BUILTIN_DECLARATIONS, builtinBinaries, builtinProviderIds } from './backends/builtin-declarations.js';
import { activeProfiles, authStatusNow, installedProfiles } from './backends/registry.js';
import { usableProviders } from './backends/usable.js';
import { isRemoteDialect } from './backends/types.js';
import type { DoctorReport, BinaryReport, BinaryProvider, ProviderAuthReport } from './plugins/contract/system.js';
export type { DoctorReport, BinaryReport, BinaryProvider, ProviderAuthReport } from './plugins/contract/system.js';

/**
 * Binaries ROOKS invokes. `required` = the orchestrator can't do anything
 * without it. `git` is not: without it Rooks runs and the Kanban runs, only
 * the git modules switch off and the git tasks of a git project are refused
 * (TODO #275) — `modules` says so, a global blocker would contradict it.
 */
export type DoctorBinary = { readonly name: string; readonly required?: true; readonly backend?: true };

/** The AI CLIs of the product's own providers, as they declare them (C1), in the order the product lists them. */
const PROVIDER_BINARIES: readonly DoctorBinary[] = builtinBinaries().map((binary) => ({ name: binary.names[0]!, backend: true as const }));

export const BINARIES: readonly DoctorBinary[] = [
  { name: 'node', required: true },
  { name: 'git' },
  ...PROVIDER_BINARIES,
  { name: 'gh' },
  { name: 'docker' },
  { name: 'grepai' },
  { name: 'uvx' },
  { name: 'tar' },
];

/** The closed list the onboarding route validates against (step 5.7.3): a
 *  prerequisite Rooks does not itself invoke is not one Rooks installs. */
export const BINARY_NAMES: readonly string[] = BINARIES.map((b) => b.name);

/**
 * Resolves a binary the same way the Host Adapter will: explicit pinning in
 * `config.host.binaries` first, PATH next. We walk PATH ourselves rather than
 * calling `which`, absent on Windows.
 */
export function whichBin(
  name: string,
  pins: Record<string, string | null> = {},
  options: BinarySearchOptions = {},
): { path: string | null; pinned: boolean } {
  const pinned = pins[name];
  if (typeof pinned === 'string' && pinned) {
    return { path: resolvePinnedBinary(name, pinned, options), pinned: true };
  }
  return { path: findExecutableBinary(name, options), pinned: false };
}

function dockerUsable(bin: string | null): { present: boolean; usable: boolean; detail: string } {
  if (!bin) return { present: false, usable: false, detail: 'binary absent' };
  // `docker info`, not `docker --version`: a client installed without a
  // reachable daemon (common on macOS) answers the version query just fine.
  const r = getHost().exec(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
  if (r.code === 0) return { present: true, usable: true, detail: `server ${r.stdout.trim()}` };
  return { present: true, usable: false, detail: r.stderr.trim().split('\n')[0] || 'daemon unreachable' };
}

/** The host adapter's probe (`host/systemd.ts`), the one place that runs `systemctl`. */
export function systemdPresent(): boolean {
  return hasSystemd();
}

/** The environment the main agent's first mission will see its credentials in. */
export function mainAgentAuthEnv(): NodeJS.ProcessEnv {
  // Setup checks the identity that will receive the first user message.
  // Only the raw config: `getAgent` would resolve the agent's default backend,
  // which asks the sign-in state, which calls this function (TIM-0119).
  const agentName = mainAgentNameOrSeed();
  const agent = loadConfig(agentName);
  return inheritEnvEnabled()
    ? process.env
    : { ...systemEnv(), ...secretsEnvFor({ agent: agentName, project: agent.project ?? projectFromCwd(agent.cwd ?? undefined) ?? null }) };
}

/** C4 for the providers that answer synchronously, which is what a diagnostic can wait for. */
/** The provider whose canonical binary is `name`, for the first-run cards. */
function providerOf(name: string): BinaryProvider | undefined {
  const entry = Object.entries(BUILTIN_DECLARATIONS).find(([, declared]) => declared.binary?.names[0] === name);
  if (!entry) return undefined;
  const [id, declared] = entry;
  return {
    id,
    label: declared.setupCard?.label ?? installedProfiles().find((profile) => profile.id === id)?.label ?? id,
    brand: installedProfiles().find((profile) => profile.id === id)?.brand ?? null,
    order: declared.setupCard?.order ?? Number.MAX_SAFE_INTEGER,
    suggested: declared.setupCard?.suggested === true,
    seedsMainAgent: declared.seedsMainAgent === true,
  };
}

function providerAuth(env: NodeJS.ProcessEnv): ProviderAuthReport[] {
  return builtinProviderIds().flatMap((provider) => {
    const binary = BUILTIN_DECLARATIONS[provider]?.binary?.names[0];
    const status = binary ? authStatusNow(provider, env as Readonly<Record<string, string>>) : null;
    if (!binary || !status) return [];
    return [{ provider, binary, ok: status.ok, detail: status.detail, signInCommand: status.signInCommand, path: status.path ?? null, source: status.source ?? null }];
  });
}

/** The seat as `DoctorReport.mainSeat` describes it. Read-only: electing is the daemon's job (`main-seat.ts`). */
export function doctorMainSeat(): DoctorReport['mainSeat'] {
  try {
    if (mainAgentOnboardingPending() || listAgents().length === 0) return null;
    return mainSeatState();
  } catch {
    // A diagnostic that cannot read the agents still reports the rest.
    return null;
  }
}

export function diagnose(): DoctorReport {
  const cfg = config();
  const pins = cfg.host.binaries;
  const authEnv = mainAgentAuthEnv();
  const auth = providerAuth(authEnv);

  const linux = process.platform === 'linux' ? linuxRelease(readOsRelease()) : null;
  const machine = { platform: process.platform, packageManager: linux?.packageManager ?? null };

  const binaries: BinaryReport[] = BINARIES.map((b) => {
    const { path, pinned } = whichBin(b.name, pins);
    const pin = pins[b.name];
    const provider = providerOf(b.name);
    return {
      name: b.name,
      ...(provider ? { provider } : {}),
      path,
      ok: path !== null,
      pinned,
      attemptedPaths: pin ? pinnedBinaryCandidates(b.name, pin)
        : [...binaryCandidates(b.name), ...(path ? [] : npmPrefixCandidates(b.name))],
      ...(pinned && !path ? { error: `host.binaries.${b.name} does not point to an executable file: ${pins[b.name]}` } : {}),
      installCommand: installCommandFor(b.name, machine),
    };
  });
  const found = (n: string) => binaries.find((b) => b.name === n)?.path ?? null;
  for (const nodeless of nodelessBackends(PROVIDER_BINARIES.map((b) => b.name), { platform: process.platform, resolve: found })) {
    const report = binaries.find((b) => b.name === nodeless.name);
    if (report) report.warning = nodelessBackendText(nodeless);
  }

  const systemd = systemdPresent();
  const docker = dockerUsable(found('docker'));
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || null;

  const capabilities: string[] = getHost().capabilities();
  const modules = moduleNotes(capabilities);

  // Read off the host adapter, never off `host/linux.ts`: `doctor` runs on
  // every platform, and a host that declares no `isolation` enforces none.
  const launcher = getHost().isolation?.launcher ?? null;
  const configured = cfg.host.isolation.filesystem;
  const missionIsolation = {
    configured,
    enforced: configured !== 'off' && launcher !== null && sandboxSupported(launcher),
    launcher,
    maskedPaths: configured === 'off' ? 0 : resolveIsolation(cfg, { novaHome: ROOKS_HOME }).deny.length,
  };

  const free = freeBytes(ROOKS_HOME);
  const storage = { path: ROOKS_HOME, freeBytes: free, low: free !== null && free < LOW_DISK_BYTES };

  const backends = BINARIES.filter((b) => 'backend' in b && b.backend).map((b) => b.name);
  const blockers: string[] = [];
  for (const b of BINARIES) {
    if ('required' in b && b.required && !found(b.name)) blockers.push(`${b.name} not found`);
  }
  // An agent reached over the network needs no CLI on this machine.
  const remoteBackend = activeProfiles().some(({ dialect }) => isRemoteDialect(dialect));
  // A provider plugin's own CLI counts too: its name is in no fixed list.
  if (!remoteBackend && !backends.some((n) => found(n)) && usableProviders().length === 0) {
    blockers.push(`no LLM backend installed (${backends.join(', ')})`);
  }
  if (cfg.host.docker === 'required' && !docker.usable) {
    blockers.push(`host.docker is "required" but Docker is unusable (${docker.detail})`);
  }

  return {
    platform: process.platform,
    home: homedir(),
    profile: cfg.profile,
    edition: cfg.edition,
    novaHome: ROOKS_HOME,
    configFile: { path: CONFIG_FILE, present: existsSync(CONFIG_FILE) },
    binaries,
    auth,
    apiKeyProviders: BUILTIN_API_KEY_PROVIDERS.map((entry) => {
      const via = BUILTIN_DECLARATIONS[entry.via]?.binary?.names[0] ?? entry.via;
      return { ...entry, via, viaLabel: via.charAt(0).toUpperCase() + via.slice(1) };
    }),
    systemd,
    supervisor: supervisorFor(process.platform, {
      systemd,
      windowsTaskRefused: process.platform === 'win32' && existsSync(windowsServiceFiles(ROOKS_HOME, join).refused),
    }),
    linux,
    docker,
    display,
    missionIsolation,
    storage,
    mainSeat: doctorMainSeat(),
    capabilities,
    modules,
    blockers,
    ok: blockers.length === 0,
  };
}

/** What the missing capabilities cost, module by module (see `DoctorReport.modules`). */
export function moduleNotes(capabilities: readonly string[]): string[] {
  const have = new Set(capabilities);
  return CATALOG.flatMap((m) => {
    const missing = (m.requires ?? []).filter((c) => !have.has(c));
    if (missing.length) return [`${m.id} off: host capability unavailable: ${missing.join(', ')}`];
    const warning = degradation(m, have);
    return warning ? [`${m.id} reduced: ${warning}`] : [];
  });
}

function mainSeatLine(seat: NonNullable<DoctorReport['mainSeat']>): string {
  if (seat.holder) return seat.holder;
  const who = seat.candidates.length > 0
    ? `eligible: ${seat.candidates.join(', ')}; in Agents, choose "Set as main orchestrator" on one`
    : 'no project-less orchestrator exists; create one in Agents';
  return `NONE — recaps and notifications have no recipient (${who})`;
}

/**
 * The masking, in one line an operator can act on. It must never read as
 * protection when nothing is emitted: `auto` on a `scope` launcher resolves a
 * policy and drops it, so the line says INERT and counts the paths that are
 * NOT protected rather than staying silent.
 */
function isolationLine(iso: DoctorReport['missionIsolation']): string {
  if (iso.configured === 'off') return 'off (host.isolation.filesystem: "off")';
  const where = iso.launcher ? `${iso.launcher} launcher` : 'no launcher isolation on this host';
  if (iso.enforced) return `enforced — ${iso.maskedPaths} path(s) masked (${where})`;
  return `INERT — ${iso.maskedPaths} path(s) in the policy, NONE masked today `
    + `(${where}; docs/SECURITY.md §9.1)`;
}

/** Text rendering of the diagnostic — the output of `rooks doctor` without `--json`. */
export function formatDoctor(r: DoctorReport): string {
  const width = Math.max(...r.binaries.map((b) => b.name.length));
  const lines = [
    `Rooks doctor — ${r.platform}, profile ${r.profile}, edition ${r.edition}`,
    `ROOKS_HOME        ${r.novaHome}`,
    `rooks.config.json ${r.configFile.present ? r.configFile.path : `absent (${r.configFile.path}) — defaults applied`}`,
    '',
    'binary'.padEnd(width) + '  ok  path',
  ];
  for (const b of r.binaries) {
    lines.push(
      b.name.padEnd(width)
      + `  ${b.ok ? ' ✓' : ' ✗'}  ${b.path ?? '—'}${b.pinned ? '  (pinned in rooks.config.json)' : ''}`,
    );
    if (b.error) lines.push(`  ${b.error}`);
    if (b.warning) lines.push(`  ${b.warning}`);
  }
  lines.push('');
  for (const auth of r.auth) {
    const name = auth.binary.charAt(0).toUpperCase() + auth.binary.slice(1);
    lines.push(`${name} credentials ${auth.ok ? 'available' : 'MISSING'}${auth.path ? ` — ${auth.path}` : ''}`, auth.detail);
  }
  lines.push(
    `systemd (user)   ${r.systemd ? 'present' : 'absent'}`,
    `supervisor       ${r.supervisor ?? 'none available — portable mode only'}`,
    `distribution     ${r.linux ? `${r.linux.prettyName ?? r.linux.id ?? 'unknown'} (${r.linux.packageManager ?? 'no known package manager'})` : 'n/a'}`,
    `docker           ${r.docker.usable ? `usable — ${r.docker.detail}` : `unusable — ${r.docker.detail}`}`,
    `graphical session ${r.display ?? 'none (DISPLAY/WAYLAND_DISPLAY empty)'}`,
    `mission FS masking ${isolationLine(r.missionIsolation)}`,
    `free disk space  ${r.storage.freeBytes === null ? 'unknown' : formatBytes(r.storage.freeBytes)}${r.storage.low ? ' — LOW: the database may fail to write' : ''}`,
    '',
    `capabilities     ${r.capabilities.join(', ') || 'none'}`,
  );
  if (r.mainSeat) lines.push(`main orchestrator ${mainSeatLine(r.mainSeat)}`);
  if (r.modules.length) {
    lines.push('', 'modules limited by this machine:');
    for (const note of r.modules) lines.push(`  - ${note}`);
  }
  if (r.blockers.length) {
    lines.push('', 'BLOCKING:');
    for (const b of r.blockers) {
      const missing = r.binaries.find((x) => !x.ok && b.startsWith(`${x.name} `));
      lines.push(`  - ${b}${missing?.installCommand ? `  →  ${missing.installCommand}` : ''}`);
    }
  } else {
    lines.push('', 'Nothing missing at the essential level (node, git, an LLM backend).');
  }
  return lines.join('\n') + '\n';
}
