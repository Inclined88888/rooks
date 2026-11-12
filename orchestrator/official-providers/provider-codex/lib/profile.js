// @ts-check
/**
 * What `rooks.provider.backends` of this package's manifest declares for `codex`, and why (the
 * manifest is JSON, the reasons live here):
 *  - `searchDirs.win32`: the official standalone installer
 *    (`irm https://chatgpt.com/codex/install.ps1 | iex`) writes `codex.exe` there and only adds it
 *    to the user PATH of later sessions;
 *  - `searchDirs.darwin`: Codex bundled with ChatGPT is a real CLI executable even though Apple never
 *    adds the app's Resources folder to the PATH;
 *  - `desktopBuilds`: `%LOCALAPPDATA%\OpenAI\Codex\bin\<hex fingerprint>\codex.exe` (Microsoft Store
 *    app), hence `folderPattern: ^[0-9a-f]+$`; the helpers next to it and
 *    `runtimes\…\codex-computer-use.exe` are not the CLI;
 *  - `apiKeyProviders`: Ollama Cloud is reached with an API key through this CLI;
 *  - `updateCheck`: the standalone builds follow the releases of `@openai/codex` on npm.
 */
/** @type {import('@rooks/sdk/provider').BackendProfile} */
export const CODEX_PROFILE = {
    id: 'codex',
    fallbackRank: 10,
    dialect: 'codex',
    // What is known (TIM-0009): 0.133.0 rejects gpt-5.6-sol, 0.153.4 accepts
    // it. The real threshold lies in between and nobody has measured it, so
    // the gate refuses only what is proven broken. Bump when the list moves.
    minCliVersion: '0.134.0',
    label: 'Codex (GPT)',
    vendor: 'OpenAI',
    brand: 'openai',
    subscription: {
      note: 'Calls go through the host ChatGPT subscription via `codex exec`. '
        + '`codex login` must have been run on the host to create the Codex auth file.',
    },
    defaultModel: 'gpt-5.6-sol',
    // Codex reports token counts without a context limit, so only a declared window can
    // give the context gauge a denominator. Missing values stay unknown.
    models: [
      { slug: 'gpt-5.6-sol', label: 'gpt-5.6-sol (default)', tier: 'flagship', contextWindow: 1_050_000, presetLabel: 'GPT-5.6 Sol', presetRank: 50, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { slug: 'gpt-6-astra', label: 'gpt-6-astra', tier: 'flagship', contextWindow: 1_050_000, presetLabel: 'GPT-6 Astra', presetRank: 48, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { slug: 'gpt-5.6-terra', label: 'gpt-5.6-terra', tier: 'mid', contextWindow: 1_050_000, presetLabel: 'GPT-5.6 Terra', presetRank: 60, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { slug: 'gpt-5.6-luna', label: 'gpt-5.6-luna', tier: 'small', contextWindow: 1_050_000, presetLabel: 'GPT-5.6 Luna', presetRank: 70, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { slug: 'gpt-5.5', label: 'gpt-5.5', tier: 'mid', contextWindow: 400_000, presetLabel: 'GPT-5.5', presetRank: 80, supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
      { slug: 'gpt-5.4', label: 'gpt-5.4', tier: 'small', contextWindow: 400_000, presetLabel: 'GPT-5.4', presetRank: 90 },
      { slug: 'gpt-5.4-mini', label: 'gpt-5.4-mini', tier: 'small', contextWindow: 200_000, presetLabel: 'GPT-5.4 mini', presetRank: 100 },
      { slug: 'gpt-5.3-codex', label: 'gpt-5.3-codex', tier: 'small', contextWindow: 200_000, presetLabel: 'GPT-5.3 codex', presetRank: 110 },
      { slug: 'gpt-5.2', label: 'gpt-5.2', tier: 'small', contextWindow: 200_000 },
    ],
  }
