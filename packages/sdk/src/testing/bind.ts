/**
 * Binding a dialect to a profile without the daemon's registry: the object the
 * runner holds for a mission (`Backend`), built the way the registry builds it —
 * credentials of the profile merged into the spawn, the profile's name stamped
 * on the `system:init`, the resume state checked against the profile's
 * credentials. What passes the suite through this binding is what the daemon
 * will run.
 */

import {
  isRemoteDialect, probeLaunchContext,
  type AnyDialect, type Backend, type BuildSpawnOpts, type NormalizedEvent, type ProfileRuntime,
  type RemoteSessionOpenArgs, type SessionOpenArgs, type SpawnResult,
} from '../provider.js';
import { providerRuntime } from './runtime.js';

const { credentialValues, serializeResumeState } = providerRuntime.resume;

export type BoundProfile = {
  /** The profile's id: what the daemon calls the provider. */
  readonly id: string;
  /** Binary; defaults to the dialect's `defaultCmd`. */
  readonly cmd?: string;
  /** The resolved environment of the profile (what its `env` resolver returned). */
  readonly env?: Readonly<Record<string, string>>;
  readonly providerConfig?: ProfileRuntime['providerConfig'];
  readonly knownModels?: readonly string[];
  readonly minCliVersion?: string;
};

/** The profile's name on the init, as the daemon stamps it (a dialect shared by
 *  several profiles cannot know which one it serves). */
function stampBackend(events: NormalizedEvent[], profileId: string): NormalizedEvent[] {
  return events.map((ev) => {
    if (ev.type !== 'system') return ev;
    const p = ev.payload as { subtype?: string } | null;
    if (!p || p.subtype !== 'init') return ev;
    return { ...ev, payload: { ...p, backend: profileId } };
  });
}

export function bindDialect(dialect: AnyDialect, profile: BoundProfile): Backend {
  const env = { ...(profile.env ?? {}) };
  const runtime = (): ProfileRuntime => ({
    id: profile.id,
    cmd: profile.cmd ?? (isRemoteDialect(dialect) ? '' : dialect.defaultCmd),
    env: { ...env },
    ...(profile.providerConfig ? { providerConfig: profile.providerConfig } : {}),
    ...(profile.knownModels ? { knownModels: profile.knownModels } : {}),
    ...(profile.minCliVersion ? { minCliVersion: profile.minCliVersion } : {}),
  });
  const common = {
    name: profile.id,
    sessionResumable: dialect.sessionResumable,
    sessionStore: dialect.sessionStore,
    permissionModel: dialect.permissionModel,
    rateLimitReporting: dialect.rateLimitReporting,
    hostedConnectors: dialect.hostedConnectors,
    ...(dialect.accountUsage
      ? { accountUsage: () => dialect.accountUsage!(runtime()) }
      : {}),
    extractSessionId: dialect.extractSessionId.bind(dialect),
    ...(dialect.spans ? { spans: dialect.spans.bind(dialect) } : {}),
    ...(dialect.dispose ? { dispose: dialect.dispose.bind(dialect) } : {}),
    ...(dialect.enrichEvent ? { enrichEvent: dialect.enrichEvent.bind(dialect) } : {}),
  };

  if (isRemoteDialect(dialect)) {
    const noProcess = (): never => { throw new Error(`backend ${profile.id} is remote: it runs no local process`); };
    const credentials = credentialValues(env);
    return {
      ...common,
      persistentProcess: true,
      finishMissionOnExit: true,
      buildSpawn: async (): Promise<SpawnResult> => noProcess(),
      writeUserInput: () => noProcess(),
      parseLine: () => noProcess(),
      openRemoteSession: (args: Omit<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'>) => dialect.openSession({
        ...args,
        host: {
          emit: (ev) => args.host.emit(stampBackend([ev], profile.id)[0]!),
          requestPermission: (req, wait) => args.host.requestPermission(req, wait),
          end: (outcome) => args.host.end(outcome),
          // The daemon's own check on what a driver may keep for a restart.
          saveResume: (state) => {
            if (state !== null) serializeResumeState(state, credentials);
            args.host.saveResume(state);
          },
        },
        profileId: profile.id,
        launch: probeLaunchContext(),
        env: { ...env },
      }),
    };
  }

  return {
    ...common,
    persistentProcess: dialect.persistentProcess,
    finishMissionOnExit: dialect.finishMissionOnExit,
    buildSpawn: async (opts: BuildSpawnOpts): Promise<SpawnResult> => dialect.buildSpawn(opts, runtime()),
    writeUserInput: dialect.writeUserInput.bind(dialect),
    parseLine: (line: string) => stampBackend(dialect.parseLine(line), profile.id),
    ...(dialect.openSession
      ? {
        openSession: (args: Omit<SessionOpenArgs, 'profileId' | 'launch'>) =>
          dialect.openSession!({ ...args, profileId: profile.id, launch: probeLaunchContext() }),
      }
      : {}),
    ...(dialect.isSessionNotFoundError ? { isSessionNotFoundError: dialect.isSessionNotFoundError.bind(dialect) } : {}),
    ...(dialect.setModel ? { setModel: dialect.setModel.bind(dialect) } : {}),
    ...(dialect.maxPromptBytes ? { maxPromptBytes: dialect.maxPromptBytes } : {}),
  };
}
