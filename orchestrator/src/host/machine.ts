/**
 * What kind of machine is this — and how does one install things on it
 * (step 5.7.1).
 *
 * Onboarding is now BLOCKING: the daemon must be installed as a service on the
 * three OSes, and a missing prerequisite must come with the command that
 * installs it. Both answers depend on facts nobody should have to type: which
 * supervisor exists here, which distribution this is, which package manager
 * comes with it.
 *
 * Everything in this file is PURE — content in, answer out. The one function
 * that touches the disk (`readOsRelease`) takes its path as a parameter and
 * returns `null` rather than throwing: a machine without `/etc/os-release`
 * (Alpine before 3.x, a scratch container, macOS, Windows) is a normal case to
 * report, not an error to propagate out of a diagnostic.
 */
import { readFileSync } from 'node:fs';
import { declaredBinary } from './declared-binaries.js';
import { tailscaleManualInstallCommand } from './tailscale-install.js';
import { builtinBinaries } from '../backends/builtin-declarations.js';
import type { InstallPlatform, ProviderInstallPlan } from '../backends/provider-declarations.js';
import type { LinuxRelease, PackageManager, SupervisorKind } from '../plugins/contract/system.js';
export type { LinuxRelease, PackageManager, SupervisorKind } from '../plugins/contract/system.js';

/**
 * `KEY=value` / `KEY="value"`, comments and blank lines ignored.
 *
 * Hand-rolled rather than shelled out to `sh -c '. /etc/os-release'`: that
 * would execute a file we only want to read, and it would need a shell — which
 * is exactly what a minimal container may not have.
 */
export function parseOsRelease(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Reads `/etc/os-release`; `null` when it is absent or unreadable. */
export function readOsRelease(file = '/etc/os-release'): Record<string, string> | null {
  try {
    return parseOsRelease(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Distribution id → package manager, for the ones that ship their own. */
const BY_ID: Readonly<Record<string, PackageManager>> = {
  debian: 'apt',
  ubuntu: 'apt',
  linuxmint: 'apt',
  pop: 'apt',
  raspbian: 'apt',
  fedora: 'dnf',
  rhel: 'dnf',
  centos: 'dnf',
  rocky: 'dnf',
  almalinux: 'dnf',
  arch: 'pacman',
  manjaro: 'pacman',
  endeavouros: 'pacman',
  opensuse: 'zypper',
  'opensuse-leap': 'zypper',
  'opensuse-tumbleweed': 'zypper',
  sles: 'zypper',
  alpine: 'apk',
};

/**
 * Which package manager this machine has.
 *
 * `ID` first, then `ID_LIKE` in order: a distribution nobody has heard of
 * derived from Debian must still land on `apt` rather than on nothing. That is
 * the whole reason `ID_LIKE` exists, and the reason a desktop derivative
 * (`ID_LIKE="ubuntu debian"`) is not a special case anywhere.
 */
export function linuxRelease(osRelease: Record<string, string> | null): LinuxRelease | null {
  if (!osRelease) return null;
  const id = osRelease['ID'] ?? null;
  const idLike = (osRelease['ID_LIKE'] ?? '').split(/\s+/).filter(Boolean);
  const candidates = [id, ...idLike].filter((v): v is string => typeof v === 'string' && v !== '');
  let packageManager: PackageManager | null = null;
  for (const candidate of candidates) {
    const found = BY_ID[candidate.toLowerCase()];
    if (found) { packageManager = found; break; }
  }
  return { id, idLike, prettyName: osRelease['PRETTY_NAME'] ?? null, packageManager };
}

/**
 * The supervisor available HERE.
 *
 * Two independent axes, deliberately not folded into one: a machine can have a
 * package manager and no supervisor (Alpine ships `apk` and OpenRC, and Timon
 * installs into no OpenRC service in v1), and `systemd` present is a fact the
 * caller measures — this function never execs anything.
 */
export function supervisorFor(
  platform: NodeJS.Platform,
  facts: { systemd: boolean; windowsTaskRefused?: boolean },
): SupervisorKind {
  if (platform === 'darwin') return 'launchd';
  // Windows registered the task but never started it for this account (an
  // Entra ID work account, TODO #342): no supervisor can serve it here.
  if (platform === 'win32') return facts.windowsTaskRefused ? null : 'windows';
  return facts.systemd ? 'systemd-user' : null;
}

/**
 * How each package manager installs a package, as an argv the user can read.
 * `-y`/`--noconfirm` on purpose: this string is offered to a human who has
 * already clicked "install", and a command that then waits for a confirmation
 * nobody sees is a command that looks hung.
 */
const INSTALL_PREFIX: Readonly<Record<PackageManager, string>> = {
  apt: 'sudo apt-get install -y',
  dnf: 'sudo dnf install -y',
  pacman: 'sudo pacman -S --noconfirm',
  zypper: 'sudo zypper install -y',
  apk: 'sudo apk add',
  brew: 'brew install',
  // `--source winget`: on a fresh Windows the `msstore` source first asks the
  // user to accept its terms, and a non-interactive install stops there with
  // exit 1 (TIM-0022). The accept flags cover the winget source's own prompt
  // and the package licence, which would stop it the same way.
  winget: 'winget install -e --source winget --accept-source-agreements --accept-package-agreements --id',
};

/**
 * Package name per manager, when it differs from the binary name. Absent =
 * the binary name is the package name.
 *
 * The LLM backends are NOT here: they declare how they install (C1 `install`,
 * `backends/builtin-declarations.ts`), and for an npm package that does not depend
 * on the distribution at all.
 */
const PACKAGE_NAMES: Readonly<Record<string, Partial<Record<PackageManager, string>>>> = {
  // LTS, not current: native modules (better-sqlite3…) had no build for Node 26
  // and failed to compile on a machine set up by the onboarding (27/09/2026).
  node: { apt: 'nodejs', winget: 'OpenJS.NodeJS.LTS', apk: 'nodejs' },
  git: { winget: 'Git.Git' },
  gh: { apt: 'gh', winget: 'GitHub.cli', brew: 'gh' },
  docker: { apt: 'docker.io', winget: 'Docker.DockerDesktop', brew: 'docker' },
  uvx: { apt: 'pipx', dnf: 'pipx', pacman: 'python-pipx', zypper: 'python3-pipx', apk: 'pipx', brew: 'uv', winget: 'astral-sh.uv' },
};

/**
 * Tools that are installed by npm whatever the OS and are NOT providers. The AI
 * CLIs say how they install in their own declaration (C1 `install`).
 */
const NPM_PACKAGES: Readonly<Record<string, string>> = {
  grepai: 'grepai',
};

/** True for a CLI that `npm install -g` puts in place, whatever the OS. */
export function installedByNpm(binary: string): boolean {
  if (Object.hasOwn(NPM_PACKAGES, binary)) return true;
  const declared = declaredBinary(binary)?.install;
  return declared !== undefined && Object.values(declared).some((plan) => plan.kind === 'npm');
}

export type Machine = { platform: NodeJS.Platform; packageManager: PackageManager | null };

/**
 * How to install a binary here: the argv to run, and whether it needs
 * elevation.
 *
 * An ARGV, not a string, because the onboarding route may execute it — and the
 * one property that route sells is that no command ever comes from the client.
 * The string form (`display`) exists for the human who has to paste it when we
 * refuse to run it ourselves.
 *
 * `elevated: true` is a refusal to execute, not a hint: `sudo` from a daemon
 * would either hang on a password prompt nobody sees, or run whatever a polkit
 * rule happens to allow. Those commands are shown, never run.
 */
export type InstallPlan = {
  display: string;
  argv: string[];
  elevated: boolean;
  /** Internal installer used when no system package manager is required. */
  installer?: 'macos-node';
};

/** The plan a PROVIDER declared for `binary` (C1 `install`) on this machine; `undefined` when it declared none. */
function declaredInstallPlan(binary: string, machine: Machine): InstallPlan | null | undefined {
  const table = declaredBinary(binary)?.install;
  if (!table) return undefined;
  const os = machine.platform === 'darwin' || machine.platform === 'win32' ? machine.platform : 'linux' satisfies InstallPlatform;
  const plan: ProviderInstallPlan | undefined = table[os] ?? table.any;
  if (!plan) return undefined;
  switch (plan.kind) {
    case 'none': return null;
    case 'npm': return { display: `npm install -g ${plan.package}`, argv: ['npm', 'install', '-g', plan.package], elevated: false };
    case 'script': {
      if (machine.platform === 'win32') {
        if (!plan.windows) return null;
        return { display: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${plan.windows}"`, argv: ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', plan.windows], elevated: false };
      }
      return plan.posix ? { display: plan.posix, argv: ['/bin/sh', '-c', plan.posix], elevated: false } : null;
    }
    case 'package': {
      const manager = machine.packageManager ?? (machine.platform === 'darwin' ? 'brew' : machine.platform === 'win32' ? 'winget' : null);
      const pkg = manager ? plan.packages[manager] : undefined;
      if (!manager || !pkg) return null;
      const prefix = INSTALL_PREFIX[manager].split(' ');
      const elevated = prefix[0] === 'sudo';
      return { display: `${INSTALL_PREFIX[manager]} ${pkg}`, argv: [...(elevated ? prefix.slice(1) : prefix), pkg], elevated };
    }
  }
}

export function installPlanFor(binary: string, machine: Machine): InstallPlan | null {
  // A provider that declared how it installs speaks for itself: the names below are the product's own.
  const declared = declaredInstallPlan(binary, machine);
  if (declared !== undefined) return declared;
  if (machine.platform === 'darwin' && binary === 'node') {
    return {
      display: 'Install Node.js 22 in ~/.local',
      argv: [],
      elevated: false,
      installer: 'macos-node',
    };
  }
  // Tailscale ships its own installer and is NOT in the default repositories
  // of Debian, Ubuntu or Fedora: the generic branch below would produce
  // `sudo apt-get install -y tailscale`, a command that fails on a stock
  // machine for a reason we invented. The official script adds the vendor
  // repository first, which is the step the package name silently assumes.
  // Marked `elevated`: it runs under `sudo`, so it is shown and never run.
  // macOS: the vendor's standalone package, not Homebrew — a prerequisite most
  // Macs do not have (25/10/2026). The one-click path is `host/tailscale-install.ts`.
  if (binary === 'tailscale') {
    if (machine.platform === 'darwin') {
      const command = tailscaleManualInstallCommand('darwin');
      return { display: command, argv: ['/bin/sh', '-c', command], elevated: true };
    }
    if (machine.platform === 'win32') {
      const command = `${INSTALL_PREFIX.winget} tailscale.tailscale`;
      return { display: command, argv: command.split(' '), elevated: false };
    }
    const command = tailscaleManualInstallCommand('linux');
    return { display: command, argv: ['/bin/sh', '-c', command], elevated: true };
  }
  const npm = NPM_PACKAGES[binary];
  if (npm) {
    return { display: `npm install -g ${npm}`, argv: ['npm', 'install', '-g', npm], elevated: false };
  }

  const manager = machine.packageManager
    ?? (machine.platform === 'darwin' ? 'brew' : machine.platform === 'win32' ? 'winget' : null);
  if (!manager) return null;
  const pkg = PACKAGE_NAMES[binary]?.[manager] ?? binary;
  const prefix = INSTALL_PREFIX[manager].split(' ');
  const elevated = prefix[0] === 'sudo';
  return {
    display: `${INSTALL_PREFIX[manager]} ${pkg}`,
    argv: [...(elevated ? prefix.slice(1) : prefix), pkg],
    elevated,
  };
}

/**
 * The AI CLIs step 3 of onboarding can install on its own: the product's own providers that
 * declare a standalone installer (`backends/builtin-declarations.ts`), by their canonical
 * binary name. A provider a plugin brings is never in this list: what the install route may run
 * is the product's decision, not a plugin's.
 */
export const INSTALLABLE_BACKENDS: readonly string[] = Object.freeze(
  builtinBinaries().flatMap((binary) => (binary.standaloneInstaller ? [binary.names[0]!] : [])));
export type InstallableBackend = string;

/**
 * The vendor's own standalone installer for an AI CLI, as its documentation
 * gives it; `null` on an OS the vendor gives no installer for. Not npm, unlike
 * `installPlanFor`: a desktop-only machine has no Node, and the standalone
 * builds need none. They install per user, without elevation, and never prompt
 * without a terminal.
 *
 * On Windows the line wraps the official `irm … | iex` in `powershell -Command`
 * so that the same text works pasted into PowerShell or CMD — the documented
 * one-liner only runs in PowerShell, and pasting it into CMD is the first
 * mistake a newcomer makes.
 */
export function installBackendPlanFor(binary: InstallableBackend, platform: NodeJS.Platform): InstallPlan | null {
  const installer = builtinBinaries().find((declared) => declared.names[0] === binary)?.standaloneInstaller;
  if (!installer) throw new Error(`${binary} has no standalone installer`);
  // The vendor documents no installer for this OS (opencode on Windows): the card links to its page.
  if (platform === 'win32') {
    if (!installer.windows) return null;
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installer.windows];
    return { display: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${installer.windows}"`, argv: ['powershell', ...args], elevated: false };
  }
  if (!installer.posix) return null;
  return { display: installer.posix, argv: ['/bin/sh', '-c', installer.posix], elevated: false };
}

/**
 * The command that installs `binary` on this machine, or `null` when we do not
 * know one — better an honest blank than a command that fails in the user's
 * terminal for a reason we invented.
 */
export function installCommandFor(binary: string, machine: Machine): string | null {
  return installPlanFor(binary, machine)?.display ?? null;
}

export type WindowsJoin = {
  /** `whoami`: the qualified account (`EUROPE\name`), unlike `userInfo().username`. */
  account: string | null;
  azureAdJoined: boolean | null;
  domainJoined: boolean | null;
  workplaceJoined: boolean | null;
};

/** `dsregcmd /status` lines are `Name : YES|NO`, in English on every locale. */
export function parseDsregcmd(output: string): Pick<WindowsJoin, 'azureAdJoined' | 'domainJoined' | 'workplaceJoined'> {
  const flag = (name: string): boolean | null => {
    const match = new RegExp(`^\\s*${name}\\s*:\\s*(YES|NO)\\s*$`, 'mi').exec(output);
    return match ? match[1]!.toUpperCase() === 'YES' : null;
  };
  return { azureAdJoined: flag('AzureAdJoined'), domainJoined: flag('DomainJoined'), workplaceJoined: flag('WorkplaceJoined') };
}

/**
 * How this Windows account is joined (TODO #342, #343): a scheduled task
 * whose S4U principal cannot be resolved on an Entra ID-joined PC is never
 * started, and says nothing. Best effort: a missing tool leaves `null`.
 */
export function windowsJoin(exec: (name: string, args: string[]) => { code: number; stdout: string }): WindowsJoin {
  let account: string | null = null;
  let join: ReturnType<typeof parseDsregcmd> = { azureAdJoined: null, domainJoined: null, workplaceJoined: null };
  try {
    const res = exec('whoami', []);
    if (res.code === 0) account = res.stdout.trim() || null;
  } catch { /* unknown */ }
  try {
    const res = exec('dsregcmd', ['/status']);
    if (res.code === 0) join = parseDsregcmd(res.stdout);
  } catch { /* unknown */ }
  return { account, ...join };
}
