'use client';

/** An idea's external references (`links`), as the detail and the tile show them. */

import type { ProjectTodoLink } from './project-todo-types';

/** The daemon only stores http(s); a link that still is not one stays text. */
export function safeHref(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch { return undefined; }
}

export function ExternalLink({ link }: { link: ProjectTodoLink }) {
  const text = link.label || `${link.provider} · ${link.ref}`;
  const href = safeHref(link.url);
  return (
    <li className="flex items-baseline gap-2 text-[12.5px]" title={`${link.provider} · ${link.ref}`}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="truncate text-primary underline-offset-2 hover:underline">
          {text}
        </a>
      ) : (
        <span className="truncate">{text}</span>
      )}
    </li>
  );
}
