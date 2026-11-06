// @ts-check
/**
 * The profile of Pi, driven over its own RPC mode. The `pi` id is the one missions, roles, series
 * fallbacks and cooldowns have named since Pi first ran through the `pi-acp` adapter; a session
 * started there is Pi's own (`pi-acp` hands Pi's session id to Timon) and reopens here with its
 * history, from the same working folder. The boot migration that renamed the preview's provisional
 * `pi-rpc` id shipped in 0.1.6 and was removed afterwards (TODO #556).
 *
 * `timon.provider.backends` of the manifest: Pi's own installers, as https://pi.dev gives them
 * (checked 29/10/2026) — `curl -fsSL https://pi.dev/install.sh | sh` and
 * `powershell -c "irm https://pi.dev/install.ps1 | iex"` (the daemon adds the `powershell` around
 * it). They install `pi` itself, the CLI this provider drives over RPC, into a managed folder
 * whose launcher lands in `~/.pi/agent/bin` when no other folder of the PATH suits it, hence
 * `searchDirs`. Both need Node.js and npm, which they offer to install from a terminal only. They
 * publish `@earendil-works/pi-coding-agent`, so the npm registry tells the newest version, and
 * `install` is that package: `npm install -g` writes a `pi.cmd` shim on Windows, which the binary
 * resolution finds. Pi signs in from inside its own interface (`signInCommand: pi`, then `/login`).
 */
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const PI_PROFILE = {
  id: 'pi',
  dialect: 'pi',
  label: 'Pi',
  vendor: 'Pi',
  brand: 'pi',
  cmd: 'pi',
  requiredBinary: manifestBackend('pi').binary?.names[0],
  // The RPC records this provider reads (`agent_settled`, `disposition`, `streamingBehavior`,
  // `--session-id` that creates or reopens) were verified on 1.4.0, the version of the bench
  // (29/10/2026). An older Pi is refused at launch with the command that updates it.
  minCliVersion: '1.4.0',
  subscription: {
    note: 'Calls go through the providers Pi itself is signed in to (`/login` in `pi` on the host, '
      + 'or the API keys Pi was given). Tool permissions follow the agent\'s permission mode, with Timon\'s Allow/Deny card.',
  },
  // Pi routes to every provider the user configured: the list comes from Pi (`pi --list-models`).
  // An empty field means "Pi's own default".
  defaultModel: null,
  models: [],
};
