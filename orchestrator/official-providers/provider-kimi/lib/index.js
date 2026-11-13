import { KIMI_PROFILE } from './profile.js';
export const name = 'provider-kimi';
export function apply(ctx) { ctx.provider.registerProductProfile(KIMI_PROFILE); }
