import type { ComponentType } from 'react';

/**
 * Typed file icons, in the manner of the Atom/JetBrains sets: a page glyph
 * in the colour of the file's family, with a short monogram. One table, so a
 * new type is one line. Colours are fixed mid-tones that read on both themes.
 */
export type FileType = { label: string; color: string };

const PDF = { label: 'PDF', color: '#e5383b' };
const WORD = { label: 'DOC', color: '#2f6fe4' };
const EXCEL = { label: 'XLS', color: '#1f9d55' };
const SLIDES = { label: 'PPT', color: '#e0612b' };
const SHELL = { label: 'SH', color: '#3fb950' };
const CPP = { label: 'C++', color: '#3f7fd0' };
const MARKDOWN = { label: 'MD', color: '#38a3d8' };
const TEXT = { label: 'TXT', color: '#8b929c' };
const IMAGE = { label: 'IMG', color: '#1fb5a6' };
const VIDEO = { label: 'VID', color: '#e0457b' };
const AUDIO = { label: 'AUD', color: '#ab4fc4' };
const ARCHIVE = { label: 'ZIP', color: '#b0803f' };
const DB = { label: 'DB', color: '#6d7fdb' };
const JS = { label: 'JS', color: '#e6b800' };
const TS = { label: 'TS', color: '#3178c6' };
const HTML = { label: 'HTML', color: '#e44d26' };
const XML = { label: 'XML', color: '#f0803c' };
const INI = { label: 'INI', color: '#8b929c' };

const BY_EXT: Record<string, FileType> = {
  // Documents
  pdf: PDF,
  doc: WORD, docx: WORD, odt: WORD, rtf: WORD,
  xls: EXCEL, xlsx: EXCEL, ods: EXCEL,
  csv: { label: 'CSV', color: '#1f9d55' }, tsv: { label: 'TSV', color: '#1f9d55' },
  ppt: SLIDES, pptx: SLIDES, odp: SLIDES,
  md: MARKDOWN, mdx: MARKDOWN, markdown: MARKDOWN,
  txt: TEXT, text: TEXT, rst: TEXT,
  log: { label: 'LOG', color: '#8b929c' },
  // Languages
  js: JS, mjs: JS, cjs: JS,
  jsx: { label: 'JSX', color: '#16b7d4' },
  ts: TS, mts: TS, cts: TS,
  tsx: { label: 'TSX', color: '#3178c6' },
  php: { label: 'PHP', color: '#8a6fd1' },
  py: { label: 'PY', color: '#4b8bbe' }, pyi: { label: 'PY', color: '#4b8bbe' },
  rb: { label: 'RB', color: '#d23c34' },
  go: { label: 'GO', color: '#00add8' },
  rs: { label: 'RS', color: '#c7673a' },
  java: { label: 'JAVA', color: '#e76f00' },
  kt: { label: 'KT', color: '#a97bff' }, kts: { label: 'KT', color: '#a97bff' },
  swift: { label: 'SWIFT', color: '#fa7343' },
  scala: { label: 'SC', color: '#dc3545' },
  dart: { label: 'DART', color: '#00b4ab' },
  ex: { label: 'EX', color: '#8e5bb5' }, exs: { label: 'EX', color: '#8e5bb5' },
  hs: { label: 'HS', color: '#8f6cc4' },
  c: { label: 'C', color: '#5c6bc0' }, h: { label: 'H', color: '#5c6bc0' },
  cpp: CPP, cc: CPP, cxx: CPP, hpp: CPP, hxx: CPP,
  cs: { label: 'C#', color: '#8a4fd3' },
  lua: { label: 'LUA', color: '#4a52c4' },
  pl: { label: 'PL', color: '#3d8fc4' }, pm: { label: 'PL', color: '#3d8fc4' },
  sol: { label: 'SOL', color: '#6c7a96' },
  sh: SHELL, bash: SHELL, zsh: SHELL, fish: SHELL,
  ps1: { label: 'PS', color: '#3b78d8' },
  sql: { label: 'SQL', color: '#d98a1c' },
  graphql: { label: 'GQL', color: '#e535ab' }, gql: { label: 'GQL', color: '#e535ab' },
  proto: { label: 'PROTO', color: '#3f9bd0' },
  // Web
  html: HTML, htm: HTML,
  css: { label: 'CSS', color: '#2f80ed' },
  scss: { label: 'SCSS', color: '#c6538c' }, sass: { label: 'SASS', color: '#c6538c' },
  less: { label: 'LESS', color: '#4a6fb5' },
  vue: { label: 'VUE', color: '#41b883' },
  svelte: { label: 'SVLT', color: '#ff3e00' },
  xml: XML, xsd: XML, plist: XML,
  svg: { label: 'SVG', color: '#f2a626' },
  // Data / config
  json: { label: '{ }', color: '#e8a317' }, jsonc: { label: '{ }', color: '#e8a317' },
  json5: { label: '{ }', color: '#e8a317' }, geojson: { label: '{ }', color: '#e8a317' },
  yaml: { label: 'YML', color: '#c0617a' }, yml: { label: 'YML', color: '#c0617a' },
  toml: { label: 'TOML', color: '#c46a3a' },
  ini: INI, cfg: INI, conf: INI, properties: INI,
  env: { label: 'ENV', color: '#d4a017' },
  lock: { label: 'LOCK', color: '#8b929c' },
  db: DB, sqlite: DB, sqlite3: DB,
  diff: { label: 'DIFF', color: '#d4793a' }, patch: { label: 'DIFF', color: '#d4793a' },
  // Media
  png: IMAGE, jpg: IMAGE, jpeg: IMAGE, webp: IMAGE, bmp: IMAGE, ico: IMAGE, avif: IMAGE,
  gif: { label: 'GIF', color: '#1fb5a6' },
  mp4: VIDEO, mov: VIDEO, webm: VIDEO, mkv: VIDEO, avi: VIDEO,
  mp3: AUDIO, wav: AUDIO, ogg: AUDIO, flac: AUDIO, m4a: AUDIO,
  // Archives
  zip: ARCHIVE, tar: ARCHIVE, gz: ARCHIVE, tgz: ARCHIVE, bz2: ARCHIVE, '7z': ARCHIVE, rar: ARCHIVE,
};

const BY_NAME: Record<string, FileType> = {
  dockerfile: { label: 'DOCK', color: '#2496ed' },
  makefile: { label: 'MAKE', color: '#6d8086' },
  readme: MARKDOWN,
  license: TEXT,
  '.gitignore': { label: 'GIT', color: '#f05133' },
  '.gitattributes': { label: 'GIT', color: '#f05133' },
  '.dockerignore': { label: 'DOCK', color: '#2496ed' },
  '.npmrc': { label: 'NPM', color: '#cb3837' },
  '.editorconfig': INI,
  '.env': { label: 'ENV', color: '#d4a017' },
};

/** The family of a file, or null when the name says nothing. */
export function fileTypeFor(name: string): FileType | null {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower]
    ?? (lower.startsWith('dockerfile.') ? BY_NAME.dockerfile : undefined)
    ?? (lower.startsWith('.env.') ? BY_NAME['.env'] : undefined);
  if (byName) return byName;
  const m = /\.([a-z0-9+]+)$/.exec(lower);
  return m?.[1] ? BY_EXT[m[1]] ?? null : null;
}

type IconProps = { className?: string };

const cache = new Map<string, ComponentType<IconProps>>();

/** One stable component per (label, colour): the tree re-renders often. */
export function fileTypeIcon({ label, color }: FileType): ComponentType<IconProps> {
  const key = label + color;
  let Icon = cache.get(key);
  if (!Icon) {
    const size = label.length <= 2 ? 7.5 : label.length === 3 ? 6.2 : 5;
    Icon = function FileTypeIcon({ className }: IconProps) {
      return (
        <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
          <path d="M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" fill={color} fillOpacity="0.16" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M14 2v5h5" fill="none" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
          <text x="12" y="17.6" textAnchor="middle" fontSize={size} fontWeight="800" fill={color} fontFamily="inherit">{label}</text>
        </svg>
      );
    };
    cache.set(key, Icon);
  }
  return Icon;
}
