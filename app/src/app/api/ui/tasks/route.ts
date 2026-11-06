import { proxyJson } from '@/lib/ui/proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Only the list's known filters travel to the daemon, nothing else.
  const query = new URLSearchParams();
  for (const key of ['status', 'full', 'done_limit', 'done_agent', 'done_project', 'done_q', 'todo_id']) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  const qs = query.toString();
  return proxyJson('GET', qs ? `/api/tasks?${qs}` : '/api/tasks');
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  return proxyJson('POST', '/api/tasks', body);
}
