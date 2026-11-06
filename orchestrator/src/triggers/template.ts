/**
 * `{field.sub.field}` templates of a trigger's actions. Only a placeholder
 * that is a valid path is replaced: `{"a": 1}` or `{ x }` in a prompt stay as
 * they are. A missing field renders empty rather than as the raw placeholder,
 * so a payload never sees its own template echoed back.
 *
 * Values are untrusted. They are inserted as text, capped, and never
 * re-expanded: a payload field holding `{secret}` renders literally.
 */
import { lookup, PATH_RE, type TriggerInput } from './payload.js';

const PLACEHOLDER = /\{([^{}\s]{1,200})\}/g;
/** One inserted value; a field cannot inflate a title into a megabyte. */
export const TEMPLATE_VALUE_MAX = 4000;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value) ?? ''; } catch { return ''; }
}

export function renderTemplate(template: string, input: TriggerInput, max: number = Number.POSITIVE_INFINITY): string {
  // A single pass over the template: replacements are never scanned again.
  const out = template.replace(PLACEHOLDER, (whole, path: string) => {
    if (!PATH_RE.test(path)) return whole;
    const text = stringify(lookup(input, path));
    return text.length > TEMPLATE_VALUE_MAX ? `${text.slice(0, TEMPLATE_VALUE_MAX)}…` : text;
  });
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
