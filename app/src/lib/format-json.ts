/** Above this, the viewer shows the text as stored rather than rewrite it. */
const MAX_FORMAT_CHARS = 2_000_000;

/**
 * Re-indents JSON for the read-only view. Valid JSON only (anything else comes
 * back untouched), and it works on the text rather than on a parsed value, so
 * a number such as 12345678901234567890 or a duplicated key is shown as stored.
 */
export function formatJson(text: string, indent = 2): string {
  if (text.length > MAX_FORMAT_CHARS) return text;
  try { JSON.parse(text); } catch { return text; }
  const pad = (n: number) => ' '.repeat(indent * n);
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      let j = i + 1;
      while (/\s/.test(text[j] ?? '')) j++;
      if (text[j] === close) { out += ch + close; i = j; } else { depth++; out += ch + '\n' + pad(depth); }
    } else if (ch === '}' || ch === ']') {
      depth--;
      out += '\n' + pad(depth) + ch;
    } else if (ch === ',') {
      out += ',\n' + pad(depth);
    } else if (ch === ':') {
      out += ': ';
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}
