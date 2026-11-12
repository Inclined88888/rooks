import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Step 5 of the wizard: is the daemon still the process that wrote the
 *  configuration, and can it restart itself? */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/setup/restart');
}

export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/setup/restart');
}
