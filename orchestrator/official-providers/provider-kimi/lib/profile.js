/**
 * `kimi` rides on the `claude` CLI with a sign-in folder of its own (`.kimi`, written once, in
 * `rooks.provider.backends` of the manifest, and declared by the profile from there): masking
 * `.claude` for it would be wrong, and leaving `.kimi` readable by other backends worse.
 */
import { manifestBackend } from './manifest.js';

export const KIMI_PROFILE = {







    id: 'kimi',
    credentialDirs: manifestBackend('kimi').credentialDirs,
    fallbackRank: 40,
    dialect: 'claude',
    label: 'Kimi (Moonshot)',
    vendor: 'Moonshot',
    brand: 'moonshot',
    custom: true,


    envFrom: {
        ANTHROPIC_AUTH_TOKEN: 'KIMI_API_KEY',
        ANTHROPIC_BASE_URL: 'KIMI_BASE_URL',
    },
    env: {
        ANTHROPIC_AUTH_TOKEN: { secret: 'KIMI_API_KEY' },


        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
    },







    defaultModel: 'kimi-k3',
    models: [
        { slug: 'kimi-k3', label: 'kimi-k3' },
        { slug: 'kimi-k2-thinking', label: 'kimi-k2-thinking' },
    ],
};
