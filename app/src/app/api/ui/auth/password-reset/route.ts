import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Public, like `setup` and `login`: asks for a reset code; the answer is the same whether an account holds the address or not.
 * The daemon owns the admission (docs/EMAIL-CODES.md) — the body is checked
 * by its zod schema, the request counted against this network's quota.
 */
export async function POST(req: Request): Promise<Response> {
  const body: unknown = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/auth/password-reset', body);
}
