/**
 * What `/api/ui/missions/:id` forwards of its query to the daemon's
 * `GET /api/missions/:id`: the light status view, and the paging of the chat
 * view (`tail`, `before`: docs/MISSION-HISTORY-PAGES.md) and the delta of a
 * cached conversation (`after`: docs/CHAT-MISSION-CACHE.md). `raw` stays on the
 * daemon side, for diagnosis. Values that are not plain integers are dropped
 * here; the daemon validates the bounds.
 */
const PAGING = ['tail', 'before', 'after'] as const;
const INTEGER = /^\d{1,16}$/;

export function forwardedMissionQuery(search: URLSearchParams): string {
  const out = new URLSearchParams();
  if (search.get('view') === 'status') out.set('view', 'status');
  for (const key of PAGING) {
    const value = search.get(key);
    if (value !== null && INTEGER.test(value)) out.set(key, value);
  }
  const query = out.toString();
  return query ? `?${query}` : '';
}
