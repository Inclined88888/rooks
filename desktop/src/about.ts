import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { themeFor } from './data-update.js';
import { shellText } from './shell-i18n.js';

/**
 * "About Timon" (TODO #582): the version of the app and the attributions of
 * the speech models. THIRD-PARTY-MODELS.md travels as an extraResource since
 * #550 because the Apache-2.0 licence of Cohere Transcribe asks for its NOTICE
 * with the software that redistributes it; this window is what leads to it.
 * The text is rendered in-app rather than handed to `shell.openPath`: a `.md`
 * file has no default application on most Windows and macOS machines.
 */
export const ABOUT_CHANNEL = 'timon:open-about';
export const THIRD_PARTY_NOTICES = 'THIRD-PARTY-MODELS.md';

/** Packaged: at the root of the resources (electron-builder.yml). From the sources: next to package.json. */
export function thirdPartyNoticesPath(input: { packaged: boolean; resourcesPath: string; desktopRoot: string }): string {
  return join(input.packaged ? input.resourcesPath : input.desktopRoot, THIRD_PARTY_NOTICES);
}

export function readThirdPartyNotices(path: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): string | null {
  try { return read(path); } catch { return null; }
}

export function aboutCopy(locale: string) {
  const t = shellText(locale);
  return {
    trayItem: t('about.item'),
    title: t('about.title'),
    version: t('about.version'),
    runtime: 'Electron',
    noticesTitle: t('about.noticesTitle'),
    noticesMissing: t('about.noticesMissing'),
    close: t('about.close'),
  };
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

/** Only an https autolink becomes a link; the window opens nothing it did not list here. */
function inline(text: string, links: string[]): string {
  return text.split(/(`[^`]+`|<https:\/\/[^\s<>]+>)/).map((part) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return `<code>${escape(part.slice(1, -1))}</code>`;
    if (part.startsWith('<https://') && part.endsWith('>')) {
      const url = part.slice(1, -1);
      links.push(url);
      return `<a href="${escape(url)}">${escape(url)}</a>`;
    }
    return escape(part);
  }).join('');
}

/**
 * The Markdown subset THIRD-PARTY-MODELS.md uses: headings, `-` lists,
 * paragraphs, inline code, https autolinks and fenced blocks. A fenced block
 * is a licence NOTICE: it is shown verbatim, line breaks kept.
 */
export function renderNotices(markdown: string): { html: string; links: string[] } {
  const links: string[] = [];
  const html: string[] = [];
  let list: string[] | null = null;
  let paragraph: string[] = [];
  let fence: string[] | null = null;
  const flushParagraph = () => { if (paragraph.length) html.push(`<p>${inline(paragraph.join(' '), links)}</p>`); paragraph = []; };
  const flushList = () => { if (list) html.push(`<ul>${list.map((item) => `<li>${inline(item, links)}</li>`).join('')}</ul>`); list = null; };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (fence) {
      if (/^```/.test(line)) { html.push(`<pre class="notice">${escape(fence.join('\n'))}</pre>`); fence = null; }
      else fence.push(raw);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (/^```/.test(line)) { flushParagraph(); flushList(); fence = []; }
    else if (!line.trim()) { flushParagraph(); flushList(); }
    else if (heading) { flushParagraph(); flushList(); html.push(`<h3>${inline(heading[2] ?? '', links)}</h3>`); }
    else if (item) { flushParagraph(); (list ??= []).push(item[1] ?? ''); }
    else if (list && /^\s/.test(line)) list[list.length - 1] += ` ${line.trim()}`;
    else { flushList(); paragraph.push(line.trim()); }
  }
  // An unclosed fence still shows its text rather than swallowing it.
  if (fence) html.push(`<pre class="notice">${escape(fence.join('\n'))}</pre>`);
  flushParagraph(); flushList();
  return { html: html.join(''), links };
}

export const ABOUT_CLOSE_URL = 'timon-about:close';

export function aboutPage(input: { version: string; electron: string; notices: string | null; locale: string; scheme: 'light' | 'dark'; appBuiltAt?: string | null; daemonVersion?: string | null; daemonBuiltAt?: string | null }): { html: string; links: string[] } {
  const THEME = themeFor(input.scheme);
  const copy = aboutCopy(input.locale);
  const { tag, dir } = shellText(input.locale);
  const notices = input.notices === null ? null : renderNotices(input.notices);
  return { links: notices?.links ?? [], html: `<!doctype html><html lang="${tag}" dir="${dir}"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${escape(copy.title)}</title><style>
:root{color-scheme:${input.scheme}}*{box-sizing:border-box}body{margin:0;background:${THEME.background};color:${THEME.foreground};font:14px/1.6 system-ui,sans-serif}main{max-width:720px;margin:auto;padding:28px 32px}h1{font-size:22px;line-height:1.3;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}h3{font-size:15px;margin:20px 0 4px}p,li{max-width:72ch;overflow-wrap:anywhere}ul{margin:4px 0;padding-left:22px}.muted{color:${THEME.muted};font-size:13px;margin:0}.tabular{font-variant-numeric:tabular-nums}a{color:${THEME.primary}}a:focus-visible{outline:3px solid ${THEME.primary};outline-offset:4px}code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:${THEME.chip};padding:1px 5px;border-radius:4px}.notice{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 system-ui,sans-serif;background:${THEME.chip};padding:12px 14px;border-radius:8px}footer{display:flex;justify-content:flex-end;margin-top:28px}.button{padding:8px 18px;border:1px solid ${THEME.border};border-radius:6px;text-decoration:none;color:${THEME.foreground}}.button:hover{filter:brightness(1.2)}
</style><main><h1>${escape(copy.title)}</h1>
<p class="muted tabular">${escape(copy.version)} ${escape(input.version)}${input.appBuiltAt ? ` · ${escape(input.appBuiltAt)}` : ''} · ${escape(copy.runtime)} ${escape(input.electron)}</p>
${input.daemonVersion || input.daemonBuiltAt ? `<p class="muted tabular">Service ${escape(input.daemonVersion ?? '')}${input.daemonBuiltAt ? ` · ${escape(input.daemonBuiltAt)}` : ''}</p>` : ''}
<h2>${escape(copy.noticesTitle)}</h2>
${notices ? `<div class="notices">${notices.html}</div>` : `<p role="alert">${escape(copy.noticesMissing)}</p>`}
<footer><a class="button" role="button" href="${ABOUT_CLOSE_URL}">${escape(copy.close)}</a></footer></main></html>` };
}

export type AboutSender = { isWindow: boolean; isMainFrame: boolean; url: string };

/**
 * The page asks the main process to open the window; nothing else crosses.
 * `allowed` is the app-info check (Timon window, main frame, its origin): a
 * frame or a page from elsewhere is refused before anything opens.
 */
export function registerAboutIpc(
  handle: (channel: string, listener: (sender: AboutSender) => void) => void,
  allowed: (sender: AboutSender) => boolean,
  open: () => void,
): void {
  handle(ABOUT_CHANNEL, (sender) => {
    if (!allowed(sender)) throw new Error('About Timon is only available from the Timon window.');
    open();
  });
}
