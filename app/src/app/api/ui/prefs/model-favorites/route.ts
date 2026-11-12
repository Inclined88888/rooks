import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The signed-in account's favourite models (ModelPicker, `docs/MODEL-PICKER.md`). Session cookie only, like every proxy route. */
export async function GET(): Promise<Response> {
  return proxyJson('GET', '/api/prefs/model-favorites');
}

/** Body: { favorites: [{ backend, model }] } — the whole ordered list, validated by the daemon. */
export async function PUT(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('PUT', '/api/prefs/model-favorites', body);
}
