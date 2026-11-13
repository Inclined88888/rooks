/**
 * PowerPoint (.pptx) → the text of each slide. This is an outline, not a
 * rendering: layout, pictures, charts and animations are not drawn.
 */
import { PreviewError, type Zip } from './zip';
import { attr, descendant, kid, kids, parseXml, readRels, relId, resolveTarget } from './xml';

export type SlideParagraph = { text: string; level: number };
export type SlidePreview = { index: number; title: string; paragraphs: SlideParagraph[]; tables: string[][][] };
export type PptxPreview = { slides: SlidePreview[]; truncated: boolean };

export const MAX_SLIDES = 300;

function paragraphText(p: Element): string {
  let out = '';
  for (const child of kids(p)) {
    if (child.localName === 'r' || child.localName === 'fld') out += kid(child, 't')?.textContent ?? '';
    else if (child.localName === 'br') out += '\n';
  }
  return out;
}

function textOf(body: Element | null): SlideParagraph[] {
  const out: SlideParagraph[] = [];
  for (const p of kids(body, 'p')) {
    const text = paragraphText(p).trim();
    if (text) out.push({ text, level: Number(attr(kid(p, 'pPr'), 'lvl') ?? 0) || 0 });
  }
  return out;
}

function collect(shapes: Element, slide: SlidePreview, titles: string[]): void {
  for (const shape of kids(shapes)) {
    if (shape.localName === 'grpSp') collect(shape, slide, titles);
    else if (shape.localName === 'sp') {
      const paragraphs = textOf(kid(shape, 'txBody'));
      const type = attr(descendant(kid(shape, 'nvSpPr'), 'ph'), 'type');
      if (type === 'title' || type === 'ctrTitle') titles.push(...paragraphs.map((p) => p.text));
      else slide.paragraphs.push(...paragraphs);
    } else if (shape.localName === 'graphicFrame') {
      const tbl = descendant(shape, 'tbl');
      if (tbl) {
        slide.tables.push(kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => textOf(kid(tc, 'txBody')).map((p) => p.text).join(' '))));
      }
    }
  }
}

export async function readPptx(zip: Zip): Promise<PptxPreview> {
  if (!zip.has('ppt/presentation.xml')) throw new PreviewError('corrupt', 'not a PowerPoint presentation');
  const presentation = parseXml(await zip.text('ppt/presentation.xml'));
  const rels = await readRels(zip, 'ppt/_rels/presentation.xml.rels');
  let paths = kids(kid(presentation, 'sldIdLst'), 'sldId')
    .map((id) => rels.get(relId(id) ?? ''))
    .filter((t): t is string => !!t)
    .map((t) => resolveTarget('ppt', t));
  if (paths.length === 0) {
    paths = zip.names()
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  }
  const truncated = paths.length > MAX_SLIDES;
  const slides: SlidePreview[] = [];
  for (const [i, path] of paths.slice(0, MAX_SLIDES).entries()) {
    const slide: SlidePreview = { index: i + 1, title: '', paragraphs: [], tables: [] };
    if (zip.has(path)) {
      const tree = descendant(parseXml(await zip.text(path)), 'spTree');
      const titles: string[] = [];
      if (tree) collect(tree, slide, titles);
      slide.title = titles.join(' ');
    }
    slides.push(slide);
  }
  return { slides, truncated };
}
