/**
 * One entry for the three Office readers, loaded on demand: the viewer imports
 * this module only when an Office file is opened, so none of it is in the
 * chat's own bundle.
 */
import { readDocx, type DocxPreview } from './docx';
import { readPptx, type PptxPreview } from './pptx';
import { openXlsx, type XlsxPreview } from './xlsx';
import { Zip } from './zip';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';
export type OfficePreviewData =
  | ({ kind: 'docx' } & DocxPreview)
  | ({ kind: 'xlsx' } & XlsxPreview)
  | ({ kind: 'pptx' } & PptxPreview);

export async function loadOffice(kind: OfficeKind, buffer: ArrayBuffer): Promise<OfficePreviewData> {
  const zip = new Zip(buffer);
  if (kind === 'docx') return { kind, ...(await readDocx(zip)) };
  if (kind === 'xlsx') return { kind, ...(await openXlsx(zip)) };
  return { kind, ...(await readPptx(zip)) };
}
