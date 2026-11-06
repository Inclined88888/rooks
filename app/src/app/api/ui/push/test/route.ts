import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Envoi de vérification — emprunte le même chemin qu'une vraie permission. */
export async function POST(): Promise<Response> {
  return proxyJson('POST', '/api/push/test');
}
