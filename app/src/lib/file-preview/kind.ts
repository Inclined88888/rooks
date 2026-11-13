/**
 * What the Files widget can show for a file, chosen from its name. The daemon
 * re-decides from the file's first bytes (`GET …/files/raw`), so a wrong guess
 * here is an error message, never a wrong render. SVG is absent on purpose: it
 * stays a text file (its source), never a document the browser interprets.
 */

export type PreviewKind = 'image' | 'video' | 'pdf' | 'docx' | 'xlsx' | 'pptx';

const BY_EXTENSION: Record<string, PreviewKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video',
  pdf: 'pdf',
  docx: 'docx', xlsx: 'xlsx', pptx: 'pptx',
};

/** The viewer for `name`, or null when it is a text file (or unknown). */
export function previewKindFor(name: string): PreviewKind | null {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return BY_EXTENSION[base.slice(dot + 1).toLowerCase()] ?? null;
}

/** Same-origin address of a file's bytes. The path is relative to the agent's
 *  working directory (absolute when `external`, a file the user confirmed) and is no secret: access is the session cookie. */
export function rawFileUrl(agentId: string, path: string, download = false, external = false): string {
  return '/api/ui/agents/' + encodeURIComponent(agentId)
    + (external ? '/files/external/raw' : '/files/raw') + '?path=' + encodeURIComponent(path) + (download ? '&download=1' : '');
}
