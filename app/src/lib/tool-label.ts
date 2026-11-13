/** Display metadata is optional: persisted tool calls often only carry a name. */
export function toolLabel(name?: string, title?: string): string {
  if (title?.trim()) return title.trim();
  if (!name) return 'Tool';
  const match = /^mcp__([^]+?)__(.+)$/.exec(name);
  if (!match) return name;
  const words = (value: string) => value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\brecv\b/gi, 'receive')
    .replace(/\bmsg\b/gi, 'message')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${words(match[1]!)} · ${words(match[2]!)}`;
}

export function toolDisplayTitle(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const tool = raw as { title?: unknown; annotations?: { title?: unknown } };
  const title = tool.title || tool.annotations?.title;
  return typeof title === 'string' && title.trim() ? title.trim() : undefined;
}
