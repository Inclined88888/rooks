/**
 * The AI CLIs of the product's providers on the daemon's machine
 * (`/api/host/provider-clis`, TODO #251): what the provider cards of the
 * onboarding's "Your AIs" step and of Settings › AI models › Providers show
 * and do. The daemon decides everything — what is installed, signed in, which
 * installer runs; this module types its answers and reads them.
 */

export type ProviderCli = {
  /** The CLI's canonical binary name: what the install route is told. */
  name: string;
  label: string;
  brand: string | null;
  /** Where the daemon finds it, `null` when it does not. */
  path: string | null;
  /** The build a desktop app ships: signing it in is enough, installing the standalone CLI stays offered. */
  bundled: boolean;
  /** `false` only when the daemon KNOWS there are no credentials; `null`: it cannot tell. */
  signedIn: boolean | null;
  /** The vendor gives an installer for this OS, which the daemon can run. */
  installable: boolean;
  installCommand: string | null;
  /** The vendor's installation page, for a CLI the daemon cannot install here. */
  installDocs: string | null;
  signInCommand: string;
  signInThen: string | null;
  /** The onboarding's chat can start on it. */
  seedsMainAgent: boolean;
  version: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /**
   * The installed binary is a major version the provider does not support (opencode 2): its
   * installer would replace it, so the daemon offers neither Install nor Update and refuses both.
   */
  unsupportedVersion: boolean;
};

export type InstallJob = {
  name: string;
  command: string;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  lines: string[];
  dropped: number;
  result: { ok: boolean; command: string | null; reason: string | null } | null;
};

export type ProviderCliList = {
  backends: ProviderCli[];
  jobs: Record<string, InstallJob>;
  /** `TIMON_CLI_UPDATE_CHECK`: off, no "Update available" is ever shown. */
  updateCheck: boolean;
};

export type ProviderCliState = 'missing' | 'bundled' | 'signIn' | 'ready';

/**
 * Where a card stands. The copy a desktop app ships runs from a terminal once it
 * is signed in: signing it in comes first, installing the standalone CLI stays
 * the alternative. `signedIn: null` (the provider cannot tell) reads as "sign
 * in", with nothing blocking.
 */
export function providerCliState(cli: Pick<ProviderCli, 'path' | 'signedIn' | 'bundled'>): ProviderCliState {
  if (!cli.path) return 'missing';
  if (cli.signedIn === true) return 'ready';
  return cli.bundled ? 'bundled' : 'signIn';
}

/**
 * Can the onboarding move on to the chat: one CLI it can start on is installed
 * and not known to be signed out. `signedIn: null` counts — refusing it would
 * leave a machine whose provider cannot tell stuck on this step forever; the
 * chat says so itself if the model then does not answer.
 */
export function readyForSetupChat(backends: readonly ProviderCli[]): boolean {
  return backends.some((cli) => cli.seedsMainAgent && cli.path !== null && cli.signedIn !== false);
}

const BASE = '/api/ui/backends/provider-clis';

export class ProviderCliError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code || `HTTP ${status}`);
    this.name = 'ProviderCliError';
  }
}

async function call<T>(method: 'GET' | 'POST', path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, cache: 'no-store' });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const code = typeof (json as { error?: unknown } | null)?.error === 'string' ? (json as { error: string }).error : '';
    throw new ProviderCliError(res.status, code);
  }
  return json as T;
}

export const fetchProviderClis = (): Promise<ProviderCliList> => call('GET', '');
/** Reads the versions again, the vendors included, before answering. */
export const checkProviderClis = (): Promise<ProviderCliList> => call('POST', '/check');
export const startProviderCliInstall = async (name: string): Promise<InstallJob> =>
  (await call<{ job: InstallJob }>('POST', `/${encodeURIComponent(name)}/install`)).job;
export const fetchProviderCliInstall = async (name: string): Promise<InstallJob> =>
  (await call<{ job: InstallJob }>('GET', `/${encodeURIComponent(name)}/install`)).job;
