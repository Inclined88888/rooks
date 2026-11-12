// @ts-check
/**
 * The ACP agents Rooks ships, as DATA (`docs/PROVIDERS-SDK.md` § 7.1, § 10.2): what used to be
 * a closed table in the core (`AGENTS` in `dialects/acp.ts`, `ADVICE` in `acp/auth.ts`) is a row
 * per agent here. The protocol — transport, session driver, event mapper, permissions through the
 * Allow/Deny card and the classifier, the model probe — is the daemon's, supplied through
 * `ctx.provider.runtime.acp`; an agent's quirk is a field of its row, never a branch.
 *
 * One provider per agent, and its id is the profile's: the folders an agent signs in to and the
 * program it runs are declared by that provider, so two agents on one dialect would share one
 * declaration of them. The profiles themselves (`opencode`, `hermes`: models, `requiredBinary`,
 * `envFrom`) are in `profiles.js`. Pi left this table for its own plugin (`provider-pi`, driven
 * over Pi's RPC mode, no `pi-acp` adapter). Each agent's `binary` and `credentialDirs` are its
 * entry of the manifest's `rooks.provider.backends` (`manifest.js`), the one place they are
 * written: the daemon reads it before this plugin runs (the doctor, the binary search, the mission
 * mask), and why its values are what they are is in `profiles.js`.
 *
 * @typedef {import('@rooks/sdk/provider').AcpAgentSpec} AcpAgentSpec
 */
import { randomBytes } from 'node:crypto';
import { manifestBackend } from './manifest.js';
import { oneShotOverlay } from './opencode-config.js';

const OPENCODE = manifestBackend('opencode');
const HERMES = manifestBackend('hermes');

/**
 * What opencode may do in a daemon one-shot (summary, title, memory pass): it decides its tool uses
 * alone, so the one-shot's refusal of every permission request never reaches it. Everything is
 * denied, then the read-only trio re-allowed: a list of denials let through every tool it did not
 * name, the MCP servers of the project's `opencode.json` first (verified on 1.18.33 with a real
 * session: `<server>_<tool>` was offered to the model). opencode keeps the LAST rule that matches,
 * so `*` comes first. `read` keeps opencode's own `.env` guard, made a refusal; `invalid` is where
 * opencode routes a malformed call, it runs nothing.
 */
const OPENCODE_ONE_SHOT_PERMISSION = Object.freeze({
  '*': 'deny',
  invalid: 'allow',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' },
  glob: 'allow',
  grep: 'allow',
});

/**
 * Our agent's name is drawn at load. `OPENCODE_CONFIG_CONTENT` is merged over the user's own
 * opencode files (the project's were read too until TODO #587), and an agent's `permission` in
 * such a file wins over the top level (verified on 1.18.33, `opencode debug agent build`): hence an
 * agent of our own, made the default one, the ACP session starting in the default agent's mode.
 * Under a fixed name, a project file declaring the same agent kept its keys ahead of ours in the
 * merge, and a `"*": "allow"` there reopened `bash` (verified with a real session). A file cannot
 * name an agent it cannot predict.
 */
const OPENCODE_ONE_SHOT_AGENT = `rooks-one-shot-${randomBytes(6).toString('hex')}`;

/**
 * Built at each one-shot launch: the project's files are not read (`OPENCODE_DISABLE_PROJECT_CONFIG`),
 * so what they said about the model is put back here, with the user's global MCP servers switched off
 * (`opencode-config.js`). The confinement comes last: nothing carried can name its keys.
 * @param {string} cwd
 */
function opencodeOneShotConfig(cwd) {
  return JSON.stringify({
    ...oneShotOverlay(cwd),
    permission: OPENCODE_ONE_SHOT_PERMISSION,
    default_agent: OPENCODE_ONE_SHOT_AGENT,
    agent: {
      [OPENCODE_ONE_SHOT_AGENT]: {
        mode: 'primary',
        description: 'Rooks one-shot prompt: answers from the prompt alone, runs nothing.',
        permission: OPENCODE_ONE_SHOT_PERMISSION,
      },
    },
  });
}

/** @type {readonly AcpAgentSpec[]} */
export const ACP_AGENTS = Object.freeze([
  {
    // opencode 1.18.33 verified against the real agent.
    id: 'opencode',
    // A whole CLI whose `acp` subcommand speaks the protocol.
    args: ['acp'],
    // It refuses a write outside its working directory without asking: the agent arbitrates its own tool uses.
    permissionsByAgent: true,
    // A one-shot reads no file of the project: its MCP servers were started, its `.opencode/` plugins run (TODO #587).
    oneShotEnv: { OPENCODE_DISABLE_PROJECT_CONFIG: '1' },
    env: (spawn) => (spawn.oneShot ? { OPENCODE_CONFIG_CONTENT: opencodeOneShotConfig(spawn.cfg.cwd ?? process.cwd()) } : {}),
    modelProbe: 'session-new',
    signIn: {
      byMethod: { 'opencode-login': 'run `opencode auth login` in a terminal on this machine, then retry' },
      fallback: 'run `opencode auth login` in a terminal on this machine, then retry',
    },
    binary: OPENCODE.binary,
    declares: { credentialDirs: OPENCODE.credentialDirs },
  },
  {
    // hermes-agent 0.21.0 verified against the real agent.
    id: 'hermes',
    // `hermes-acp` speaks the protocol as launched.
    args: [],
    permissionsByAgent: false,
    modelProbe: 'session-new',
    signIn: {
      byMethod: {
        nous: 'sign in to Nous with `hermes --setup` in a terminal on this machine, then retry',
        'hermes-setup': 'run `hermes --setup` in a terminal on this machine, then retry',
      },
      fallback: 'run `hermes --setup` in a terminal on this machine, then retry',
    },
    binary: HERMES.binary,
    declares: { credentialDirs: HERMES.credentialDirs },
  },
]);
