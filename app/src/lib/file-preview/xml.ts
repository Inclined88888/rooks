/**
 * Namespace-blind helpers over the DOM of an OOXML part. The prefixes of a
 * document (`w:`, `a:`, `x:`…) are the writer's choice; only the local name
 * carries meaning, so every lookup goes by it.
 */
import { PreviewError } from './zip';

export function parseXml(text: string): Element {
  // An entity declaration is never in an Office part; refusing it up front
  // keeps entity expansion out of the picture whatever the parser does.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new PreviewError('corrupt', 'unexpected DTD in document');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName === 'parsererror' || doc.getElementsByTagName('parsererror').length > 0) {
    throw new PreviewError('corrupt', 'malformed XML');
  }
  return root;
}

export function kids(el: Element | null | undefined, name?: string): Element[] {
  if (!el) return [];
  return Array.from(el.children).filter((c) => name === undefined || c.localName === name);
}

export function kid(el: Element | null | undefined, name: string): Element | null {
  return kids(el, name)[0] ?? null;
}

/** First descendant, depth first, with this local name. */
export function descendant(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (const child of Array.from(el.children)) {
    if (child.localName === name) return child;
    const found = descendant(child, name);
    if (found) return found;
  }
  return null;
}

export function attr(el: Element | null | undefined, local: string): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
}

/** The `r:id` of an element. Not `attr(el, 'id')`: a slide entry carries a plain
 *  `id` too, and only the relationships namespace says which one is meant. */
export function relId(el: Element | null | undefined): string | null {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) {
    if (a.localName === 'id' && (a.namespaceURI ?? '').endsWith('/relationships')) return a.value;
  }
  return null;
}

/** A boolean property element (`<w:b/>`, `<w:b w:val="0"/>`). */
export function flag(parent: Element | null, name: string): boolean {
  const el = kid(parent, name);
  if (!el) return false;
  const v = attr(el, 'val');
  return v === null || !/^(0|false|off|none)$/i.test(v);
}

/** Relationship id → target, from a `.rels` part. */
export async function readRels(zip: { has(n: string): boolean; text(n: string): Promise<string> }, path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!zip.has(path)) return out;
  const root = parseXml(await zip.text(path));
  for (const rel of kids(root, 'Relationship')) {
    const id = attr(rel, 'Id');
    const target = attr(rel, 'Target');
    if (id && target) out.set(id, target);
  }
  return out;
}

/** A relationship target as a path inside the archive, relative to the part
 *  that declares it (`base` = its directory, no trailing slash). */
export function resolveTarget(base: string, target: string): string {
  const parts = target.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
