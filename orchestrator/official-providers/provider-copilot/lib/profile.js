// @ts-check
/**
 * The profile of GitHub Copilot: its fallback models, `requiredBinary`, `envFrom` for
 * `COPILOT_HOME` / `GH_HOST`. Moved verbatim from the product's former table
 * (`orchestrator/src/backends/profiles.ts`); the id is unchanged, it is a foreign key of every
 * installation (missions, roles, series fallbacks, cooldowns).
 *
 * `timon.provider.backends` of the manifest: `winget install GitHub.Copilot` is a portable package,
 * its link lands in `WinGet\Links`, which winget adds to the user PATH of later sessions only
 * (TIM-0093), hence `searchDirs.win32` (`--scope machine` uses the Program Files twin). The package
 * itself (`GitHub.Copilot_<source>`, `GitHub.Copilot.Prerelease_<source>`) keeps its executable at
 * the root of its folder, hence `desktopBuilds` and its `folderPattern`; the `Links` shim beside it
 * is only a symlink.
 *
 * `standaloneInstaller.windows` is also what the card's Update button runs. A Copilot CLI already
 * there is updated by `copilot update`, whatever installed it (npm, winget): the CLI updates
 * itself, and winget's own record of the package drifts from it, so `winget install` answered
 * "No newer package versions" while the card announced one (TIM-0138). The line adds the user
 * and machine PATH first (npm and winget put the CLI there, Node's installer puts `node` there for
 * the npm shim), since the daemon may have started before them. After `copilot update` it exits
 * explicitly with the CLI's own code, so a failed update ends the job as failed (a `.cmd`, an `.exe`
 * and npm's `.ps1` shim all set LASTEXITCODE). No `$` and no `"` in it, hence `Get-Variable
 * LASTEXITCODE -ValueOnly`: the card shows the line inside `-Command "…"` for pasting into
 * PowerShell or CMD. PowerShell would expand a `$variable` before the inner shell sees it, and the
 * backtick that would escape it there reaches the inner shell intact when pasted into CMD.
 *
 * `standaloneInstaller.posix` has the same shape (TODO #789): the vendor's script writes to
 * `~/.local/bin`, while the CLI the card reads may come from npm or a Homebrew cask. `copilot
 * update` downloads the release and swaps it in at its own executable path (read from the CLI's
 * code, 1.0.105): the binary inside npm's `node_modules`, the one in `Caskroom`, the script's
 * copy. In a folder the account cannot write (a sudo install, a root-owned npm prefix) it exits 1
 * and says so, which a curl fallback would hide behind a second copy. The line appends to PATH the
 * folders the daemon searches after it (`binaryCandidates`), in its order and for the running OS
 * only (`uname`), so `command -v` finds the copy the card shows: the fixed ones, then nvm's
 * `versions/node/<folder>/bin` under `$NVM_DIR` (or `~/.nvm`) for a `x.y.z` or `vx.y.z` folder
 * without leading zeros, highest version first (`sort` per field: a glob would put v9 above v18).
 * A custom npm prefix is found when it is on the daemon's PATH, the only place the daemon looks
 * for one off Windows. Out of reach of a static line of at most 500 characters (TODO #799, the
 * installer is not given the resolved path): a `host.binaries` pin, and nvm folders carrying a
 * SemVer pre-release or build metadata, which the daemon accepts and ranks (SemVer §11 takes
 * ~830 characters of sh). There the line may update another copy, or run the script.
 * `if/then/else`, never `&& ||`: a failed update must not fall through to the script.
 */
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const COPILOT_PROFILE = {
  // GitHub Copilot CLI (`@github/copilot`), backed by the host's Copilot
  // seat — personal or company. `copilot login` holds the account; Timon
  // stores no token for it (cf. the `provider-copilot` plugin).
  //
  // `requiredBinary`, like grok: without the CLI the profile does not exist,
  // and nothing is offered that would die ENOENT at spawn.
  id: 'copilot',
  dialect: 'copilot',
  label: 'GitHub Copilot',
  vendor: 'GitHub',
  brand: 'github',
  requiredBinary: manifestBackend('copilot').binary?.names[0],
  // Where the CLI keeps its login, and which GitHub it signs in to (GitHub
  // Enterprise with data residency). A mission's environment is a whitelist
  // (SECRETS-VAULT.md §6.1): without this, a daemon started with either would
  // spawn missions that look for the login elsewhere, and see none. None of
  // them is a credential; an unset one is simply not passed.
  envFrom: { COPILOT_HOME: 'COPILOT_HOME', GH_HOST: 'GH_HOST', COPILOT_GH_HOST: 'COPILOT_GH_HOST' },
  subscription: {
    note: 'Calls go through the GitHub Copilot subscription of the account '
      + 'signed in with `copilot login` on the host (premium requests, no '
      + 'per-token API billing). The models offered are the ones your '
      + "organisation's Copilot policy allows.",
  },
  // `auto` lets Copilot pick among the models the organisation allows: any
  // named default could be one an admin disabled.
  defaultModel: 'auto',
  // FALLBACK only: the live list comes from the CLI itself
  // (`Dialect.discoverModels`), because it depends on the organisation's
  // policy. These are the models GitHub documented for the CLI on
  // 29/09/2026. No `slugPrefixes`: the same `gpt-*` and `claude-*` slugs are
  // served first-hand by codex and claude, and claiming their namespace
  // would steal them (cf. catalogClaimsModel). No `contextWindow` either —
  // it depends on the seat, and an invented figure is worse than none.
  models: [
    { slug: 'auto', label: 'auto (Copilot picks)', presetLabel: 'Copilot auto', presetRank: 120 },
    { slug: 'claude-sonnet-4.6', label: 'claude-sonnet-4.6' },
    { slug: 'claude-opus-5.5', label: 'claude-opus-5.5' },
    { slug: 'claude-haiku-4.5', label: 'claude-haiku-4.5' },
    { slug: 'gpt-5.4', label: 'gpt-5.4' },
    { slug: 'gpt-6-sol', label: 'gpt-6-sol' },
    { slug: 'gpt-6-astra', label: 'gpt-6-astra' },
    { slug: 'gpt-6-luna', label: 'gpt-6-luna' },
    { slug: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { slug: 'gemini-3.7-flash', label: 'gemini-3.7-flash' },
  ],
};
