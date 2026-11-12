import { PLATFORM_MODULE_SOURCES } from '@/lib/plugin-host/platform-modules';

export async function GET(_request: Request, { params }: { params: { module: string } }): Promise<Response> {
  const source = PLATFORM_MODULE_SOURCES[params.module];
  return new Response(source ?? 'throw new Error("module plateforme inconnu")', { status: source ? 200 : 404, headers: { 'content-type': 'text/javascript; charset=utf-8' } });
}
