import { proxyJson } from '@/lib/ui/proxy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Starts the vendor's official installer of one CLI; the body carries nothing — the daemon picks the command. */
export async function POST(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('POST', `/api/host/provider-clis/${encodeURIComponent(params.name)}/install`, {});
}
/** The install job and its console, polled while it runs. */
export async function GET(_req: Request, { params }: { params: { name: string } }): Promise<Response> {
  return proxyJson('GET', `/api/host/provider-clis/${encodeURIComponent(params.name)}/install`);
}
