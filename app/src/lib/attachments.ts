/**
 * The composer's attachments, on the client.
 *
 * An image stays what it was: inline bytes the model sees. Everything else —
 * PDF, .pptx, .csv, .zip — goes to the host's disk and the agent opens it
 * with its tools (`orchestrator/src/chat-attachments.ts`). A long paste is a
 * third case: it is not a file, it is the human's text taken out of the input
 * so the input stays readable.
 *
 * The icon is picked from the EXTENSION, never from the MIME type: a .pptx
 * dragged from a file explorer regularly arrives as
 * `application/octet-stream`, and a .csv as `application/vnd.ms-excel`. The
 * name does not lie.
 */

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

/** Beyond this, a paste is taken out of the input and becomes a "Pasted"
 *  attachment. High enough for a copied command or a commit message to stay
 *  plain text, low enough for a log file not to drown the field. */
export const PASTE_AS_FILE_CHARS = 1200;
/** Images + files of one message — mirror of `MAX_TURN_BYTES` on the daemon.
 *  Everything travels base64 (+33 %) in one JSON body the daemon caps at
 *  25 MB: 18 MB is what fits with room for the text (TIM-0125). Checked here
 *  so the user hears it when adding, not as a 413 when sending. */
export const MAX_TURN_BYTES = 18 * 1024 * 1024;
/** Per file — mirror of `MAX_ATTACHMENT_BYTES` on the daemon. */
export const MAX_ATTACHMENT_BYTES = MAX_TURN_BYTES;

export type PendingFile = {
  id: string;
  /** `file` = bytes to persist; `pasted` = text taken out of the input. */
  kind: 'file' | 'pasted';
  name: string;
  mediaType: string;
  /** base64 without prefix, for a `file`. */
  base64?: string;
  /** Raw content, for a `pasted`. */
  text?: string;
  size: number;
};

type IconSpec = { icon: LucideIcon; tone: string };

const BY_EXTENSION: Readonly<Record<string, IconSpec>> = {
  pdf: { icon: FileType, tone: 'text-rose-500' },
  doc: { icon: FileText, tone: 'text-blue-500' },
  docx: { icon: FileText, tone: 'text-blue-500' },
  odt: { icon: FileText, tone: 'text-blue-500' },
  rtf: { icon: FileText, tone: 'text-blue-500' },
  txt: { icon: FileText, tone: 'text-muted-foreground' },
  log: { icon: FileText, tone: 'text-muted-foreground' },
  md: { icon: FileText, tone: 'text-muted-foreground' },
  mdx: { icon: FileText, tone: 'text-muted-foreground' },
  xls: { icon: FileSpreadsheet, tone: 'text-emerald-500' },
  xlsx: { icon: FileSpreadsheet, tone: 'text-emerald-500' },
  ods: { icon: FileSpreadsheet, tone: 'text-emerald-500' },
  csv: { icon: FileSpreadsheet, tone: 'text-emerald-500' },
  tsv: { icon: FileSpreadsheet, tone: 'text-emerald-500' },
  ppt: { icon: Presentation, tone: 'text-orange-500' },
  pptx: { icon: Presentation, tone: 'text-orange-500' },
  odp: { icon: Presentation, tone: 'text-orange-500' },
  key: { icon: Presentation, tone: 'text-orange-500' },
  png: { icon: FileImage, tone: 'text-violet-500' },
  jpg: { icon: FileImage, tone: 'text-violet-500' },
  jpeg: { icon: FileImage, tone: 'text-violet-500' },
  gif: { icon: FileImage, tone: 'text-violet-500' },
  webp: { icon: FileImage, tone: 'text-violet-500' },
  svg: { icon: FileImage, tone: 'text-violet-500' },
  avif: { icon: FileImage, tone: 'text-violet-500' },
  heic: { icon: FileImage, tone: 'text-violet-500' },
  mp3: { icon: FileAudio, tone: 'text-pink-500' },
  wav: { icon: FileAudio, tone: 'text-pink-500' },
  ogg: { icon: FileAudio, tone: 'text-pink-500' },
  flac: { icon: FileAudio, tone: 'text-pink-500' },
  m4a: { icon: FileAudio, tone: 'text-pink-500' },
  mp4: { icon: FileVideo, tone: 'text-pink-500' },
  mov: { icon: FileVideo, tone: 'text-pink-500' },
  webm: { icon: FileVideo, tone: 'text-pink-500' },
  mkv: { icon: FileVideo, tone: 'text-pink-500' },
  avi: { icon: FileVideo, tone: 'text-pink-500' },
  zip: { icon: FileArchive, tone: 'text-amber-500' },
  rar: { icon: FileArchive, tone: 'text-amber-500' },
  gz: { icon: FileArchive, tone: 'text-amber-500' },
  tar: { icon: FileArchive, tone: 'text-amber-500' },
  tgz: { icon: FileArchive, tone: 'text-amber-500' },
  '7z': { icon: FileArchive, tone: 'text-amber-500' },
  json: { icon: FileJson, tone: 'text-yellow-500' },
  jsonl: { icon: FileJson, tone: 'text-yellow-500' },
  yaml: { icon: FileJson, tone: 'text-yellow-500' },
  yml: { icon: FileJson, tone: 'text-yellow-500' },
  toml: { icon: FileJson, tone: 'text-yellow-500' },
  ts: { icon: FileCode, tone: 'text-sky-500' },
  tsx: { icon: FileCode, tone: 'text-sky-500' },
  js: { icon: FileCode, tone: 'text-sky-500' },
  jsx: { icon: FileCode, tone: 'text-sky-500' },
  py: { icon: FileCode, tone: 'text-sky-500' },
  rb: { icon: FileCode, tone: 'text-sky-500' },
  go: { icon: FileCode, tone: 'text-sky-500' },
  rs: { icon: FileCode, tone: 'text-sky-500' },
  java: { icon: FileCode, tone: 'text-sky-500' },
  c: { icon: FileCode, tone: 'text-sky-500' },
  h: { icon: FileCode, tone: 'text-sky-500' },
  cpp: { icon: FileCode, tone: 'text-sky-500' },
  cs: { icon: FileCode, tone: 'text-sky-500' },
  php: { icon: FileCode, tone: 'text-sky-500' },
  sh: { icon: FileCode, tone: 'text-sky-500' },
  sql: { icon: FileCode, tone: 'text-sky-500' },
  html: { icon: FileCode, tone: 'text-sky-500' },
  css: { icon: FileCode, tone: 'text-sky-500' },
};

/** Lower-case extension, without the dot. Empty for a name that has none
 *  (`Dockerfile`, `Makefile`) — those fall back on the generic icon. */
export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Icon and tint of a file name. An unknown type is never a refusal: it gets
 *  the generic icon and is sent like the others. */
export function fileIconFor(name: string): IconSpec {
  return BY_EXTENSION[extensionOf(name)] ?? { icon: File, tone: 'text-muted-foreground' };
}

export function fmtAttachmentSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Bytes the pending attachments put in the message: images as compressed,
 *  files as read, a long paste as its UTF-8 text. */
export function turnAttachmentBytes(
  images: ReadonlyArray<{ size: number }>,
  files: ReadonlyArray<PendingFile>,
): number {
  let total = 0;
  for (const image of images) total += image.size;
  for (const file of files) {
    total += file.kind === 'pasted' ? new TextEncoder().encode(file.text ?? '').length : file.size;
  }
  return total;
}

/** Admits candidates in order while the message stays within
 *  `MAX_TURN_BYTES`; a too-big one is refused, a smaller one after it may
 *  still fit. */
export function admitWithinTurnBudget<T extends { size: number }>(
  used: number,
  candidates: readonly T[],
): { admitted: T[]; refused: T[]; used: number } {
  const admitted: T[] = [];
  const refused: T[] = [];
  let total = used;
  for (const candidate of candidates) {
    if (total + candidate.size > MAX_TURN_BYTES) {
      refused.push(candidate);
      continue;
    }
    total += candidate.size;
    admitted.push(candidate);
  }
  return { admitted, refused, used: total };
}
