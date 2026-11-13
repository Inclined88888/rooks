/**
 * Map file extensions / kinds to a Lucide icon component + a tint colour.
 * Used by the chat sidebar Files tab to surface file types at a glance
 * without needing to read the name.
 *
 * Lucide is already in the bundle (lucide-react), so this is free in
 * terms of dependencies — just a small lookup table.
 */
import type { ComponentType } from 'react';
import { fileTypeFor, fileTypeIcon } from './file-type-icons';
import {
  Folder,
  FolderOpen,
  File,
  FileCode2,
  FileText,
  FileJson,
  FileType,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  Settings,
  Terminal,
  Lock,
  GitBranch,
  Database,
  Globe,
} from 'lucide-react';

export type IconKind = 'dir' | 'file' | 'symlink' | 'other';

type IconSpec = {
  Icon: ComponentType<{ className?: string }>;
  /** Tailwind text-* class for the icon tint. */
  tint: string;
};

const CODE_TINT = 'text-[hsl(var(--info))]';
const MD_TINT = 'text-foreground';
const CONFIG_TINT = 'text-[hsl(var(--warning))]';
const IMAGE_TINT = 'text-[hsl(var(--primary))]';
const ARCHIVE_TINT = 'text-muted-foreground';
const SHELL_TINT = 'text-[hsl(var(--success))]';
const DEFAULT_TINT = 'text-muted-foreground/70';

const BY_EXT: Record<string, IconSpec> = {
  // Code
  ts: { Icon: FileCode2, tint: CODE_TINT },
  tsx: { Icon: FileCode2, tint: CODE_TINT },
  js: { Icon: FileCode2, tint: CODE_TINT },
  jsx: { Icon: FileCode2, tint: CODE_TINT },
  mjs: { Icon: FileCode2, tint: CODE_TINT },
  cjs: { Icon: FileCode2, tint: CODE_TINT },
  py: { Icon: FileCode2, tint: CODE_TINT },
  rb: { Icon: FileCode2, tint: CODE_TINT },
  php: { Icon: FileCode2, tint: CODE_TINT },
  rs: { Icon: FileCode2, tint: CODE_TINT },
  go: { Icon: FileCode2, tint: CODE_TINT },
  java: { Icon: FileCode2, tint: CODE_TINT },
  kt: { Icon: FileCode2, tint: CODE_TINT },
  swift: { Icon: FileCode2, tint: CODE_TINT },
  c: { Icon: FileCode2, tint: CODE_TINT },
  h: { Icon: FileCode2, tint: CODE_TINT },
  cpp: { Icon: FileCode2, tint: CODE_TINT },
  hpp: { Icon: FileCode2, tint: CODE_TINT },
  cs: { Icon: FileCode2, tint: CODE_TINT },
  sol: { Icon: FileCode2, tint: CODE_TINT },
  lua: { Icon: FileCode2, tint: CODE_TINT },
  // Web
  html: { Icon: Globe, tint: CODE_TINT },
  htm: { Icon: Globe, tint: CODE_TINT },
  xml: { Icon: FileCode2, tint: CODE_TINT },
  svg: { Icon: FileImage, tint: IMAGE_TINT },
  css: { Icon: FileType, tint: CODE_TINT },
  scss: { Icon: FileType, tint: CODE_TINT },
  sass: { Icon: FileType, tint: CODE_TINT },
  less: { Icon: FileType, tint: CODE_TINT },
  // Markdown / text
  md: { Icon: FileText, tint: MD_TINT },
  mdx: { Icon: FileText, tint: MD_TINT },
  rst: { Icon: FileText, tint: MD_TINT },
  txt: { Icon: FileText, tint: DEFAULT_TINT },
  log: { Icon: FileText, tint: DEFAULT_TINT },
  // Config / data
  json: { Icon: FileJson, tint: CONFIG_TINT },
  jsonc: { Icon: FileJson, tint: CONFIG_TINT },
  yaml: { Icon: Settings, tint: CONFIG_TINT },
  yml: { Icon: Settings, tint: CONFIG_TINT },
  toml: { Icon: Settings, tint: CONFIG_TINT },
  ini: { Icon: Settings, tint: CONFIG_TINT },
  env: { Icon: Lock, tint: CONFIG_TINT },
  // Shell / make
  sh: { Icon: Terminal, tint: SHELL_TINT },
  bash: { Icon: Terminal, tint: SHELL_TINT },
  zsh: { Icon: Terminal, tint: SHELL_TINT },
  fish: { Icon: Terminal, tint: SHELL_TINT },
  ps1: { Icon: Terminal, tint: SHELL_TINT },
  // Images
  png: { Icon: FileImage, tint: IMAGE_TINT },
  jpg: { Icon: FileImage, tint: IMAGE_TINT },
  jpeg: { Icon: FileImage, tint: IMAGE_TINT },
  gif: { Icon: FileImage, tint: IMAGE_TINT },
  webp: { Icon: FileImage, tint: IMAGE_TINT },
  ico: { Icon: FileImage, tint: IMAGE_TINT },
  bmp: { Icon: FileImage, tint: IMAGE_TINT },
  // Archives
  zip: { Icon: FileArchive, tint: ARCHIVE_TINT },
  tar: { Icon: FileArchive, tint: ARCHIVE_TINT },
  gz: { Icon: FileArchive, tint: ARCHIVE_TINT },
  tgz: { Icon: FileArchive, tint: ARCHIVE_TINT },
  bz2: { Icon: FileArchive, tint: ARCHIVE_TINT },
  '7z': { Icon: FileArchive, tint: ARCHIVE_TINT },
  rar: { Icon: FileArchive, tint: ARCHIVE_TINT },
  // Media
  mp4: { Icon: FileVideo, tint: IMAGE_TINT },
  mov: { Icon: FileVideo, tint: IMAGE_TINT },
  webm: { Icon: FileVideo, tint: IMAGE_TINT },
  mp3: { Icon: FileAudio, tint: IMAGE_TINT },
  wav: { Icon: FileAudio, tint: IMAGE_TINT },
  ogg: { Icon: FileAudio, tint: IMAGE_TINT },
  // DB / data
  sql: { Icon: Database, tint: CODE_TINT },
  db: { Icon: Database, tint: CODE_TINT },
  sqlite: { Icon: Database, tint: CODE_TINT },
  csv: { Icon: Database, tint: CONFIG_TINT },
  // Misc
  pdf: { Icon: FileText, tint: DEFAULT_TINT },
};

const BY_NAME: Record<string, IconSpec> = {
  'Dockerfile': { Icon: Settings, tint: CONFIG_TINT },
  'Makefile': { Icon: Settings, tint: CONFIG_TINT },
  'README': { Icon: FileText, tint: MD_TINT },
  'LICENSE': { Icon: FileText, tint: DEFAULT_TINT },
  '.gitignore': { Icon: GitBranch, tint: DEFAULT_TINT },
  '.gitattributes': { Icon: GitBranch, tint: DEFAULT_TINT },
  '.env': { Icon: Lock, tint: CONFIG_TINT },
  '.env.local': { Icon: Lock, tint: CONFIG_TINT },
  '.env.example': { Icon: Lock, tint: DEFAULT_TINT },
};

/** Returns the icon + tint for an entry. `expanded` toggles the folder
 *  icon between closed/open variants. */
export function iconFor(
  name: string,
  kind: IconKind,
  expanded = false,
): IconSpec {
  if (kind === 'dir') {
    return {
      Icon: expanded ? FolderOpen : Folder,
      tint: 'text-[hsl(var(--primary))]',
    };
  }
  // Known families get a dedicated, coloured glyph (see file-type-icons).
  const type = fileTypeFor(name);
  if (type) return { Icon: fileTypeIcon(type), tint: '' };
  // Exact name match wins (Dockerfile, .gitignore, …) over extension.
  if (BY_NAME[name]) return BY_NAME[name];
  // Match by extension. Leading-dot files with no further extension
  // (.env, .gitignore) were caught above; otherwise pop the last `.X`.
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  if (m) {
    const ext = (m[1] ?? '').toLowerCase();
    if (BY_EXT[ext]) return BY_EXT[ext];
  }
  return { Icon: File, tint: DEFAULT_TINT };
}

/** Map an extension to a highlight.js language id, or null when we
 *  don't have a sensible guess. Used by the file viewer to pick a
 *  syntax for the preview. */
export function hljsLanguageFor(name: string): string | null {
  const lower = name.toLowerCase();
  // Files recognised by their name, not their extension. `.env.local`,
  // `.env.production`: the extension would point at "local", hence the
  // prefix rather than a strict equality.
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';
  if (lower === '.env' || lower.startsWith('.env.')) return 'ini';
  if (lower === '.gitignore' || lower === '.dockerignore' || lower === '.npmignore') return 'bash';
  if (lower === '.gitconfig' || lower === '.editorconfig' || lower === '.npmrc') return 'ini';
  if (lower === '.bashrc' || lower === '.zshrc' || lower === '.profile') return 'bash';

  const m = /\.([A-Za-z0-9+]+)$/.exec(name);
  if (!m) return null;
  const ext = (m[1] ?? '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyi: 'python', rb: 'ruby', php: 'php', rs: 'rust', go: 'go',
    java: 'java', kt: 'kotlin', kts: 'kotlin', swift: 'swift', scala: 'scala',
    dart: 'dart', ex: 'elixir', exs: 'elixir', hs: 'haskell',
    lua: 'lua', pl: 'perl', pm: 'perl', ps1: 'powershell',
    c: 'c', h: 'c', cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp',
    cs: 'csharp',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    json: 'json', jsonc: 'json', json5: 'json', lock: 'json', geojson: 'json',
    yaml: 'yaml', yml: 'yaml',
    toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
    properties: 'properties',
    html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
    plist: 'xml', xsd: 'xml',
    css: 'css', scss: 'scss', sass: 'scss', less: 'less',
    md: 'markdown', mdx: 'markdown', markdown: 'markdown',
    sql: 'sql', psql: 'sql',
    graphql: 'graphql', gql: 'graphql',
    proto: 'protobuf',
    diff: 'diff', patch: 'diff',
    http: 'http',
    mk: 'makefile',
    txt: 'plaintext', log: 'plaintext', csv: 'plaintext', text: 'plaintext',
    sol: 'javascript', // Solidity reads ok with JS highlighter — no native hljs grammar bundled.
  };
  return map[ext] ?? null;
}
