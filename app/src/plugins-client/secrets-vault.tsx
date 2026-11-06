'use client';

import { registerPage } from './page';
import dynamic from 'next/dynamic';
import type { BundledClientPlugin } from './types';
import { SecretRequestCard } from '@/components/chat/secret-request-card';
import { CHAT_SECRET_REQUEST_SLOT } from '@/lib/plugin-host/slots';

// Loaded on demand: statically imported, it weighed on every page of the app.
const SecretsPage = dynamic(() => import('./secrets-vault/page').then((m) => m.SecretsPage), { ssr: false });

export const coreSecretsClient: BundledClientPlugin = {
  module: '@timon/secrets-vault',
  apply(ctx) {
    // Reached from Settings → Secrets; the route stays for direct links.
    registerPage(ctx, { route: '/secrets', Component: SecretsPage });
    // The card of an agent's `secret_request`, as the default occupant of its
    // boot slot: a plugin's replacement keeps the slot whatever cards come and go.
    ctx.register({ slot: CHAT_SECRET_REQUEST_SLOT, fallback: true }, SecretRequestCard);
  },
};
