/**
 * What `timon.provider.backends` of this package's manifest declares for `claude`, and why (the
 * manifest is JSON, the reasons live here):
 *  - `install.darwin: none`: on macOS Claude is accepted when already present or explicitly pinned,
 *    but onboarding only installs the preferred automatic backend (Codex);
 *  - `searchDirs.darwin`: the legacy local installer (`~/.claude/local`); the build the Claude
 *    desktop app ships (`desktopBuilds`) comes after, so a separately installed CLI keeps priority;
 *  - `signInThen: /login`: the CLI does not sign in by itself, `/login` inside `claude` does;
 *  - `apiKeyProviders`: DeepSeek and Kimi are reached with an API key through this CLI;
 *  - `updateCheck`: the native installer follows the same releases as `@anthropic-ai/claude-code`
 *    on npm, so the registry tells the newest version (`installDocs`: Anthropic's setup page).
 */
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_PROFILE = {
    id: 'claude',
    fallbackRank: 30,
    dialect: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    brand: 'anthropic',
    subscription: {
        note: "Calls go through the host's Claude Code subscription "
            + '(no per-token API billing).',
        planMaxToggle: true,
    },
    defaultModel: 'sonnet',
    slugPrefixes: ['claude-'],




    models: [
        { slug: 'fable', label: 'fable', tier: 'flagship', contextWindow: 1_000_000, presetLabel: 'Fable', presetRank: 10, supportedReasoningLevels: CLAUDE_EFFORTS },
        { slug: 'sonnet', label: 'sonnet', tier: 'mid', contextWindow: 200_000, presetLabel: 'Sonnet', presetRank: 30, supportedReasoningLevels: CLAUDE_EFFORTS },
        { slug: 'opus', label: 'opus', tier: 'flagship', contextWindow: 1_000_000, presetLabel: 'Opus', presetRank: 20, supportedReasoningLevels: CLAUDE_EFFORTS },
        { slug: 'haiku', label: 'haiku', tier: 'small', contextWindow: 200_000, presetLabel: 'Haiku', presetRank: 40, supportedReasoningLevels: CLAUDE_EFFORTS },
    ],
};
