// @ts-check
/**
 * Cursor's agent as DATA: the one row this plugin hands to the daemon's ACP runtime
 * (`ctx.provider.runtime.acp.defineProvider`). The protocol — transport, session driver, permission
 * round trip through the Allow/Deny card, event mapping — is the daemon's; what is Cursor's is below.
 *
 * Sources: https://cursor.com/docs/cli/acp and https://cursor.com/docs/cli/installation (read 18/10/2026, extension
 * methods 30/10/2026). Nothing here was observed on a real `cursor-agent`: see README.md, "Known limits" — and the
 * `unverified` list below, which Timon shows with the backend.
 *
 * @typedef {import('@timon-ai/sdk/provider').AcpAgentSpec} AcpAgentSpec
 * @typedef {import('@timon-ai/sdk/provider').ProviderUnverified} ProviderUnverified
 */
import { CURSOR_EXTENSIONS } from './extensions.js'

/** The sentence a user reads when the agent wants a sign-in. */
const SIGN_IN = 'run `cursor-agent login` in a terminal on this machine, then retry';

/** @type {AcpAgentSpec} */
export const CURSOR = Object.freeze({
  id: 'cursor',
  // `cursor-agent acp`: documented as "advanced", absent from `--help`. The whole CLI speaks ACP behind that subcommand.
  args: ['acp'],
  // Cursor sends `session/request_permission` ("If your client does not answer permission requests, tool execution can block"):
  // Timon arbitrates every tool use, through the card and the classifier.
  permissionsByAgent: false,
  // Which models an account offers is Cursor's to say, not this file's. The probe leaves an empty session in Cursor's history.
  modelProbe: 'session-new',
  // The one method Cursor announces. Tried ONCE, only if `session/new` answers `auth_required`: it reuses the sign-in
  // `cursor-agent login` stored and opens nothing by itself.
  authenticateWith: 'cursor_login',
  signIn: { byMethod: { cursor_login: SIGN_IN }, fallback: SIGN_IN },
  binary: {
    // The canonical name, then `agent`, which Cursor's documentation also uses. `agent` alone proves nothing (grok installs
    // one in the same folder): the identity below, mirrored in package.json, refuses a namesake on the authorization click
    // and before every launch. `index.js` puts first the name this machine resolves.
    names: ['cursor-agent', 'agent'],
    install: {
      any: { kind: /** @type {'script'} */ ('script'), posix: 'curl https://cursor.com/install -fsS | bash', windows: "irm 'https://cursor.com/install?win32=true' | iex" },
    },
    // Checked on the authorization click (the copy in package.json, which must stay identical), before a mission starts the
    // program and before the model probe: a program that does not print a dated version (Cursor's builds are named by
    // date, `2026.10.16-…`) is refused, saying what it printed.
    identity: { args: ['--version'], pattern: '\\b20\\d{2}\\.\\d{1,2}\\.\\d{1,2}\\b', expected: "Cursor's agent CLI, a dated version such as 2026.10.16" },
  },
  // Cursor's own blocking requests: its multiple-choice questions and its plans, put to the person as Timon cards.
  extensionRequests: CURSOR_EXTENSIONS,
  // The folders `cursor-agent` keeps its sign-in and configuration in. Spared from the mission's mask for a Cursor mission only,
  // masked from every other backend. `.config/cursor` is a guess for Linux: confirm on a real install (A-TESTER).
  declares: {
    credentialDirs: ['.cursor', '.config/cursor'],
    // Shown with the backend (an Unverified chip in the model picker): what this plugin has never seen work.
    unverified: /** @type {ProviderUnverified[]} */ ([
      { subject: 'session', note: 'Written from Cursor\'s ACP documentation; its tests replay reconstructed sessions, not recorded ones.' },
      { subject: 'mcp', note: 'Timon\'s tools are declared through the session; Cursor documents only .cursor/mcp.json, so they may be missing.' },
      { subject: 'extension-requests', note: 'Questions and plans follow the shapes Cursor documents; never answered by a real cursor-agent.' },
      { subject: 'credential-dirs', note: '~/.config/cursor is a guess for Linux; native Windows keeps its configuration elsewhere.' },
      { subject: 'binary-identity', note: 'The dated version banner is inferred from Cursor\'s release names, not read from a real install.' },
    ]),
  },
});
