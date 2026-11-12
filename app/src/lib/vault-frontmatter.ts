/**
 * YAML front matter of the vault notes, read on the client.
 *
 * A deliberately narrow subset: scalars, inline lists `[a, b]` and dash
 * lists. The vault writes nothing else, and a real YAML parser would cost a
 * dependency to read five keys.
 */

export interface VaultProp {
  key: string;
  /** Always a list: a scalar key is a list of one item. */
  values: string[];
  /** `true` when the key held a list in the YAML (`[a, b]` or dashes). */
  list: boolean;
}

export interface ParsedNote {
  props: VaultProp[];
  body: string;
}

/** Target of a wikilink, without anchor or alias: `[[a/b|Title]]` → `a/b`. */
export function wikilinkTarget(value: string): string | null {
  const m = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
  if (!m) return null;
  const inner = m[1] ?? '';
  const target = (inner.split('|')[0] ?? '').split(/[#^]/)[0]?.trim();
  return target ? target : null;
}

/** Displayed label of a wikilink: the alias if any, otherwise the target. */
export function wikilinkLabel(value: string): string {
  const m = /^\[\[([^\]]+)\]\]$/.exec(value.trim());
  if (!m) return value;
  const inner = m[1] ?? '';
  const [target, alias] = inner.split('|');
  return (alias ?? target ?? value).trim();
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length > 1 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Splits an inline list on the commas OUTSIDE brackets and quotes:
 * `related` holds `[[a/b]]` items, and a naive split would break them in two.
 */
function splitInline(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth <= 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter((v) => v !== '');
}

export function parseVaultNote(raw: string): ParsedNote {
  const text = raw.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return { props: [], body: text };

  const props: VaultProp[] = [];
  let current: VaultProp | null = null;

  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && current) {
      const v = unquote(item[1] ?? '');
      if (v) current.values.push(v);
      current.list = true;
      continue;
    }

    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[1] ?? '').trim();
    const rest = (kv[2] ?? '').trim();

    if (rest.startsWith('[') && rest.endsWith(']')) {
      current = { key, values: splitInline(rest.slice(1, -1)), list: true };
    } else if (rest === '') {
      // Bare key: the dash list that follows fills it.
      current = { key, values: [], list: false };
    } else {
      current = { key, values: [unquote(rest)], list: false };
    }
    props.push(current);
  }

  return {
    props: props.filter((p) => p.values.length > 0),
    body: text.slice(m[0].length),
  };
}
