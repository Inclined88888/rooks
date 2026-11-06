/**
 * Excel (.xlsx) → cell text, one sheet at a time. Values are shown as the file
 * stores them: no number formatting beyond turning date-formatted serials back
 * into dates, no formulas, no charts, no merged cells.
 */
import { PreviewError, type Zip } from './zip';
import { attr, descendant, kid, kids, parseXml, readRels, relId, resolveTarget } from './xml';

export type SheetPreview = { name: string; rows: string[][]; columns: number; truncated: boolean };
export type XlsxPreview = { sheetNames: string[]; load: (index: number) => Promise<SheetPreview> };

export const MAX_SHEET_ROWS = 1000;
export const MAX_SHEET_COLUMNS = 100;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(id: number, code: string | undefined): boolean {
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  if (!code) return false;
  // Quoted text, escaped characters and [colour]/[locale] tags are not tokens.
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(bare);
}

function serialToText(serial: number, epoch1904: boolean): string {
  const days = epoch1904 ? serial + 1462 : serial;
  const date = new Date(Math.round((days - 25569) * 86_400_000));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16).replace('T', ' ');
}

/** "AB12" → column index 27. */
function columnOf(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Concatenated text of a shared string or inline string, phonetic runs left out. */
function richText(el: Element | null): string {
  if (!el) return '';
  let out = '';
  for (const child of kids(el)) {
    if (child.localName === 't') out += child.textContent ?? '';
    else if (child.localName === 'r') out += richText(child);
  }
  return out;
}

export async function openXlsx(zip: Zip): Promise<XlsxPreview> {
  if (!zip.has('xl/workbook.xml')) throw new PreviewError('corrupt', 'not an Excel workbook');
  const workbook = parseXml(await zip.text('xl/workbook.xml'));
  const rels = await readRels(zip, 'xl/_rels/workbook.xml.rels');
  const epoch1904 = /^(1|true)$/i.test(attr(descendant(workbook, 'workbookPr'), 'date1904') ?? '');
  const sheets = kids(kid(workbook, 'sheets'), 'sheet').flatMap((sheet) => {
    const target = rels.get(relId(sheet) ?? '');
    return target ? [{ name: attr(sheet, 'name') ?? 'Sheet', path: resolveTarget('xl', target) }] : [];
  });
  if (sheets.length === 0) throw new PreviewError('corrupt', 'the workbook has no sheet');

  const shared: string[] = zip.has('xl/sharedStrings.xml')
    ? kids(parseXml(await zip.text('xl/sharedStrings.xml')), 'si').map(richText)
    : [];

  // Style index → is it a date?
  const dateStyle: boolean[] = [];
  if (zip.has('xl/styles.xml')) {
    const styles = parseXml(await zip.text('xl/styles.xml'));
    const codes = new Map<number, string>();
    for (const f of kids(kid(styles, 'numFmts'), 'numFmt')) codes.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
    for (const xf of kids(kid(styles, 'cellXfs'), 'xf')) {
      const id = Number(attr(xf, 'numFmtId') ?? 0);
      dateStyle.push(isDateFormat(id, codes.get(id)));
    }
  }

  async function load(index: number): Promise<SheetPreview> {
    const sheet = sheets[index];
    if (!sheet || !zip.has(sheet.path)) throw new PreviewError('corrupt', 'missing sheet');
    const data = kid(parseXml(await zip.text(sheet.path)), 'sheetData');
    const rows: string[][] = [];
    let columns = 0;
    let truncated = false;
    let next = 0;
    for (const row of kids(data, 'row')) {
      const r = Number(attr(row, 'r')) || next + 1;
      next = r;
      if (r > MAX_SHEET_ROWS) { truncated = true; break; }
      const cells: string[] = [];
      let col = 0;
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r');
        col = ref ? columnOf(ref) : col;
        if (col >= MAX_SHEET_COLUMNS) { truncated = true; col++; continue; }
        const t = attr(c, 't');
        const v = kid(c, 'v')?.textContent ?? '';
        let text = v;
        if (t === 's') text = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') text = richText(kid(c, 'is'));
        else if (t === 'b') text = v === '1' ? 'TRUE' : 'FALSE';
        else if ((t === null || t === 'n') && v !== '' && dateStyle[Number(attr(c, 's') ?? 0)] && Number.isFinite(Number(v))) {
          text = serialToText(Number(v), epoch1904);
        }
        if (text !== '') {
          while (cells.length < col) cells.push('');
          cells[col] = text;
        }
        col++;
      }
      while (rows.length < r - 1) rows.push([]);
      rows[r - 1] = cells;
      columns = Math.max(columns, cells.length);
    }
    return { name: sheet.name, rows, columns, truncated };
  }

  return { sheetNames: sheets.map((s) => s.name), load };
}
