// @ts-check
/**
 * The profile of Grok Build: its model, its fallback rank, `requiredBinary`. Moved verbatim from the
 * product's former table (`orchestrator/src/backends/profiles.ts`); the id is unchanged, it is a
 * foreign key of every installation (missions, roles, series fallbacks, cooldowns).
 *
 * `timon.provider.backends` of the manifest: xAI's own installers, as their headers give them —
 * `curl -fsSL https://x.ai/cli/install.sh | bash` and `irm https://x.ai/cli/install.ps1 | iex`. Not
 * an npm package: `@vibe-kit/grok-cli` is a community wrapper. Both write `grok` to `~/.grok/bin`
 * (`$GROK_BIN_DIR` overrides it), a folder only later shells get on their PATH, hence `searchDirs`.
 * `updateCheck.latest.text`: the installer resolves "latest" the same way, from
 * `https://x.ai/cli/stable`, a plain-text version.
 */
import { manifestBackend } from './manifest.js';

/** @type {import('@timon-ai/sdk/provider').BackendProfile} */
export const GROK_PROFILE = {
  // Grok Build CLI (xAI), backed by the host's SuperGrok / X Premium+
  // subscription: `grok login` writes ~/.grok/auth.json, which the dialect
  // links into each mission's GROK_HOME. No API key is involved.
  //
  // `requiredBinary` rather than `requiredEnv`: nothing is set in the
  // environment, the presence of the CLI decides. On a machine without `grok`
  // the profile is absent from the registry and the catalogue, exactly like a
  // third-party profile without credentials.
  id: 'grok',
  fallbackRank: 20,
  dialect: 'grok',
  label: 'Grok (xAI)',
  vendor: 'xAI',
  brand: 'xai',
  requiredBinary: manifestBackend('grok').binary?.names[0],
  subscription: {
    note: 'Calls go through the SuperGrok / X Premium+ subscription via the '
      + '`grok` CLI (no per-token API billing). `grok login` must have been run '
      + 'on the host to create ~/.grok/auth.json.',
  },
  defaultModel: 'grok-4.6',
  slugPrefixes: ['grok-'],
  // One model exposed by the CLI today (`grok models`). The window comes from
  // the `result.modelUsage[*].contextWindow` the stream really carries — as for
  // claude, it is not invented here.
  models: [
    {
      slug: 'grok-4.6',
      tier: 'flagship',
      label: 'grok-4.6 (default)',
      contextWindow: 500_000,
      presetLabel: 'Grok 4.6',
      presetRank: 45,
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
};
