/**
 * The `repo` of a Git proxy request (TODO #923): which of the project's
 * repositories the widget reads. Relayed as is — the daemon validates it and
 * refuses a path outside the project — and dropped when absent, so a request
 * without it still reaches the project root as before.
 */
export function repoSuffix(req: Request, sep: '?' | '&' = '?'): string {
  const repo = new URL(req.url).searchParams.get('repo');
  return repo ? `${sep}repo=${encodeURIComponent(repo)}` : '';
}
