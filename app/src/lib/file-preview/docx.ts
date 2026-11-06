/**
 * Word (.docx) → a list of plain blocks. The result is data, not HTML: the
 * viewer renders it as React nodes, so nothing a document says can become
 * markup. Text, headings, lists, bold / italic / underline / strike and
 * tables are kept; images, comments, headers and footers are not.
 */
import { PreviewError, type Zip } from './zip';
import { attr, descendant, flag, kid, kids, parseXml } from './xml';

export type Run = { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean };
export type DocBlock =
  | { kind: 'paragraph'; runs: Run[]; heading?: 1 | 2 | 3 | 4 | 5 | 6; marker?: string; level?: number }
  | { kind: 'table'; rows: DocBlock[][][] };
export type DocxPreview = { blocks: DocBlock[]; truncated: boolean };

const MAX_BLOCKS = 4000;
const MAX_DEPTH = 4;

type StyleInfo = { name: string; num?: { numId: string; level: number } };

function readStyles(root: Element | null): Map<string, StyleInfo> {
  const out = new Map<string, StyleInfo>();
  for (const style of kids(root, 'style')) {
    const id = attr(style, 'styleId');
    if (!id) continue;
    const numPr = kid(kid(style, 'pPr'), 'numPr');
    const numId = attr(kid(numPr, 'numId'), 'val');
    out.set(id, {
      name: (attr(kid(style, 'name'), 'val') ?? '').toLowerCase(),
      ...(numId ? { num: { numId, level: Number(attr(kid(numPr, 'ilvl'), 'val') ?? 0) || 0 } } : {}),
    });
  }
  return out;
}

/** numId → per-level number format ("bullet", "decimal", …). */
function readNumbering(root: Element | null): Map<string, string[]> {
  const abstracts = new Map<string, string[]>();
  for (const abs of kids(root, 'abstractNum')) {
    const id = attr(abs, 'abstractNumId');
    if (!id) continue;
    const levels: string[] = [];
    for (const lvl of kids(abs, 'lvl')) {
      levels[Number(attr(lvl, 'ilvl') ?? 0) || 0] = attr(kid(lvl, 'numFmt'), 'val') ?? 'decimal';
    }
    abstracts.set(id, levels);
  }
  const out = new Map<string, string[]>();
  for (const num of kids(root, 'num')) {
    const id = attr(num, 'numId');
    const abs = attr(kid(num, 'abstractNumId'), 'val');
    if (id && abs && abstracts.has(abs)) out.set(id, abstracts.get(abs) ?? []);
  }
  return out;
}

function roman(n: number): string {
  const table: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
  let out = '';
  for (const [value, sym] of table) while (n >= value) { out += sym; n -= value; }
  return out;
}

function letters(n: number): string {
  let out = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) out = String.fromCharCode(97 + ((k - 1) % 26)) + out;
  return out;
}

function markerFor(fmt: string, n: number): string {
  switch (fmt) {
    case 'bullet': return '•';
    case 'none': return '';
    case 'lowerLetter': return letters(n) + '.';
    case 'upperLetter': return letters(n).toUpperCase() + '.';
    case 'lowerRoman': return roman(n) + '.';
    case 'upperRoman': return roman(n).toUpperCase() + '.';
    default: return n + '.';
  }
}

export async function readDocx(zip: Zip): Promise<DocxPreview> {
  if (!zip.has('word/document.xml')) throw new PreviewError('corrupt', 'not a Word document');
  const body = kid(parseXml(await zip.text('word/document.xml')), 'body');
  if (!body) throw new PreviewError('corrupt', 'not a Word document');
  const styles = zip.has('word/styles.xml') ? readStyles(parseXml(await zip.text('word/styles.xml'))) : new Map<string, StyleInfo>();
  const numbering = zip.has('word/numbering.xml') ? readNumbering(parseXml(await zip.text('word/numbering.xml'))) : new Map<string, string[]>();
  const counters = new Map<string, number[]>();
  let count = 0;
  let truncated = false;

  function runsOf(container: Element, out: Run[]): void {
    for (const child of kids(container)) {
      switch (child.localName) {
        case 'r': {
          const props = kid(child, 'rPr');
          let text = '';
          for (const part of kids(child)) {
            if (part.localName === 't') text += part.textContent ?? '';
            else if (part.localName === 'tab') text += '\t';
            else if (part.localName === 'br' || part.localName === 'cr') text += '\n';
            else if (part.localName === 'noBreakHyphen') text += '‑';
          }
          if (text) {
            out.push({
              text,
              ...(flag(props, 'b') ? { bold: true } : {}),
              ...(flag(props, 'i') ? { italic: true } : {}),
              ...(kid(props, 'u') && attr(kid(props, 'u'), 'val') !== 'none' ? { underline: true } : {}),
              ...(flag(props, 'strike') ? { strike: true } : {}),
            });
          }
          break;
        }
        // Hyperlinks, smart tags, content controls, tracked insertions: their
        // text is kept, the link target is not.
        case 'hyperlink': case 'smartTag': case 'fldSimple': case 'ins': case 'sdtContent': case 'sdt':
          runsOf(child, out);
          break;
        default:
      }
    }
  }

  function paragraph(p: Element): DocBlock {
    const props = kid(p, 'pPr');
    const styleId = attr(kid(props, 'pStyle'), 'val') ?? '';
    const style = styles.get(styleId);
    const styleName = style?.name ?? styleId.toLowerCase();
    let heading: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
    const m = /^(?:heading|titre)\s*([1-6])$/.exec(styleName);
    if (m) heading = Number(m[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    else if (styleName === 'title') heading = 1;
    else if (styleName === 'subtitle') heading = 2;
    const outline = attr(kid(props, 'outlineLvl'), 'val');
    if (!heading && outline !== null && Number(outline) >= 0 && Number(outline) <= 5) heading = (Number(outline) + 1) as 1 | 2 | 3 | 4 | 5 | 6;

    const numPr = kid(props, 'numPr');
    const numId = attr(kid(numPr, 'numId'), 'val') ?? style?.num?.numId;
    const level = numPr ? Number(attr(kid(numPr, 'ilvl'), 'val') ?? 0) || 0 : style?.num?.level ?? 0;
    let marker: string | undefined;
    if (numId && numId !== '0' && !heading) {
      const seen = counters.get(numId) ?? [];
      seen[level] = (seen[level] ?? 0) + 1;
      seen.length = level + 1;
      counters.set(numId, seen);
      marker = markerFor(numbering.get(numId)?.[level] ?? 'bullet', seen[level] ?? 1);
    }
    const runs: Run[] = [];
    runsOf(p, runs);
    return { kind: 'paragraph', runs, ...(heading ? { heading } : {}), ...(marker !== undefined ? { marker, level } : {}) };
  }

  function blocksOf(container: Element, depth: number, out: DocBlock[]): void {
    for (const child of kids(container)) {
      if (count >= MAX_BLOCKS) { truncated = true; return; }
      if (child.localName === 'p') {
        count++;
        out.push(paragraph(child));
      } else if (child.localName === 'tbl' && depth < MAX_DEPTH) {
        count++;
        const rows: DocBlock[][][] = [];
        for (const tr of kids(child, 'tr')) {
          rows.push(kids(tr, 'tc').map((tc) => {
            const cell: DocBlock[] = [];
            blocksOf(tc, depth + 1, cell);
            return cell;
          }));
        }
        out.push({ kind: 'table', rows });
      } else if (child.localName === 'sdt') {
        blocksOf(descendant(child, 'sdtContent') ?? child, depth, out);
      }
    }
  }

  const blocks: DocBlock[] = [];
  blocksOf(body, 0, blocks);
  return { blocks, truncated };
}
