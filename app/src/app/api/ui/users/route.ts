import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Read-only: the account picker of a shared subscription account
// (`backend-accounts-settings.tsx`) names the people it is shared with.
// Creating an account belongs to the plugin that serves the accounts.
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/users');
}
