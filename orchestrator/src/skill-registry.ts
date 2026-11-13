/**
 * Unified, multi-source skill registry. Rooks long knew a single source
 * (`~/.rooks/skills/`); this module ALSO aggregates:
 *   - global Claude Code skills          (`~/.claude/skills/<id>/SKILL.md`)
 *   - global Claude slash commands       (`~/.claude/commands/**​/*.md`)
 *   - a project's skills/commands        (`<cwd>/.claude/{skills,commands}`)
 *   - plugin skills/commands             (`~/.claude/plugins/cache/.../`)
 *
 * Purpose: visibility (Skills page, picker, chat autocompletion) AND
 * resolution of `/<id>`. Attaching a skill to an agent lives elsewhere
 * (`skill_attachments`, `skill-attachments.ts`) and is limited to Rooks skills
 * on purpose: `readSkillsContent` only resolves `~/.rooks`.
 *
 * What a mission really sees: a claude mission runs with
 * `CLAUDE_CONFIG_DIR=~/.rooks/backend-accounts/<id>`, so the `claude-user`
 * (`~/.claude/skills|commands`) and `plugin` (`~/.claude/plugins`) sources are
 * NOT visible to it. They are listed here for the operator, not loaded by the
 * agents. Only the `.claude/{skills,commands}` of the project's cwd
 * (`project`) are loaded natively by Claude Code. To make a `claude-user` or
 * `plugin` skill available to missions it is IMPORTED (`importSkill`): copied
 * into `~/.rooks/skills/<id>/`, it becomes a `rooks` skill, hence attachable.
 * A plugin is imported skill by skill, never whole: its hooks and MCP servers
 * are a security surface.
 *
 * Everything is best-effort: a missing folder, an unreadable file or a
 * malformed frontmatter is skipped, never fatal.
 */
import {
  constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ROOKS_HOME, SKILLS_DIR, skillFile } from './paths.js';
import { SkillExistsError, readToolsValue, writeSkillFile } from './skills.js';

export type SkillSource = 'rooks' | 'claude-user' | 'project' | 'plugin';
export type SkillFormat = 'rooks' | 'claude-skill' | 'claude-cmd';

export type SkillEntry = {
  /** Invocation identifier. May contain `:` for namespaces
   *  (`plugin:cmd`, commands subfolder `dir:cmd`). */
  id: string;
  title: string;
  description: string;
  source: SkillSource;
  format: SkillFormat;
  scope: 'global' | 'project';
  /** Absolute path of the underlying markdown file. */
  path: string;
  /** Can the ROOKS UI edit/delete this file? (plugins cannot). */
  editable: boolean;
  allowed_tools?: string[];
  argument_hint?: string;
  model?: string;
  /** A skill of higher precedence carries the same id → shadowed. */
  shadowed?: boolean;
  size: number;
  updated_at: number;
};

const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const ID_RE = /^[a-z0-9][a-z0-9._:-]*$/i;

/** Precedence (smaller = wins on an id collision). */
const SOURCE_RANK: Record<SkillSource, number> = {
  project: 0,
  rooks: 1,
  'claude-user': 2,
  plugin: 3,
};

/* ───────────────────────── frontmatter ───────────────────────── */

export type ParsedFrontmatter = {
  name?: string;
  description?: string;
  argument_hint?: string;
  model?: string;
  allowed_tools?: string[];
};

/** The front-matter block `parseFrontmatter` reads; the write guard tests
 *  this very block (users/skills-mcp-guard.ts). */
export const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/** Minimal and tolerant YAML parser: `key: value` scalars; for the tools,
 *  every list of `readToolsValue`. Only the known keys are extracted. */
export function parseFrontmatter(content: string): { fm: ParsedFrontmatter; body: string } {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return { fm: {}, body: content };
  const block = m[1]!;
  const body = content.slice(m[0].length);
  const fm: ParsedFrontmatter = {};
  // CRLF too: `$` in the key pattern below does not match before a `\r`.
  const lines = block.split('\n').map((line) => line.replace(/\r$/, ''));

  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '').trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const val = kv[2]!.trim();

    switch (key) {
      case 'name': fm.name = unquote(val); break;
      case 'description': fm.description = unquote(val); break;
      case 'argument-hint': case 'argument_hint': fm.argument_hint = unquote(val); break;
      case 'model': fm.model = unquote(val); break;
      case 'allowed-tools': case 'allowed_tools': {
        // Same reading as `parseSkillFrontmatter`: both spellings, their union.
        const { tools, consumed } = readToolsValue(val, lines.slice(i + 1));
        i += consumed;
        fm.allowed_tools = [...new Set([...(fm.allowed_tools ?? []), ...tools])];
        break;
      }
      default: break;
    }
  }
  return { fm, body };
}

/** Displayable title: `name` from the frontmatter, otherwise the first `# heading`, otherwise the id. */
function deriveTitle(content: string, fm: ParsedFrontmatter, fallback: string): string {
  if (fm.name) return fm.name;
  const h = /^#\s+(.+)$/m.exec(content);
  return h ? h[1]!.trim() : fallback;
}

/** First non-empty line of the body, truncated — fallback description. */
function deriveDescription(body: string, fm: ParsedFrontmatter): string {
  if (fm.description) return fm.description;
  const firstPara = body.replace(/^#.*$/m, '').trim().split('\n').find((l) => l.trim());
  return firstPara ? firstPara.trim().slice(0, 200) : '';
}

/**
 * The one line a skill gets in an agent's catalogue: its frontmatter
 * `description` (standard Agent Skills field), else the first paragraph. On
 * one line, because a folded YAML description (`>`) is read as its marker only.
 */
export function describeSkill(content: string): string {
  const { fm, body } = parseFrontmatter(content);
  const folded = fm.description === '>' || fm.description === '|' || fm.description === '>-' || fm.description === '|-';
  const text = deriveDescription(body, folded ? {} : fm).replace(/\s+/g, ' ').trim();
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

/* ───────────────────────── scanners ───────────────────────── */

function safeStat(path: string): { size: number; mtimeMs: number } | null {
  try { const s = statSync(path); return { size: s.size, mtimeMs: s.mtimeMs }; }
  catch { return null; }
}

function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function listDirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { return []; }
}

/** Recursive list of the `*.md` under a folder (for namespaced commands). */
function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: import('node:fs').Dirent[];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** Skills format-dossier (`<dir>/<id>/SKILL.md`) : ROOKS, claude skills, plugin skills. */
function scanSkillDir(
  baseDir: string, source: SkillSource, scope: 'global' | 'project',
  editable: boolean, idPrefix = '',
): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const name of listDirs(baseDir)) {
    const file = join(baseDir, name, 'SKILL.md');
    const st = safeStat(file);
    if (!st) continue;
    const content = safeRead(file);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    const id = idPrefix ? `${idPrefix}:${name}` : name;
    if (!ID_RE.test(id)) continue;
    out.push({
      id,
      title: deriveTitle(content, fm, name),
      description: deriveDescription(body, fm),
      source, format: source === 'rooks' ? 'rooks' : 'claude-skill', scope,
      path: file, editable,
      allowed_tools: fm.allowed_tools,
      size: st.size, updated_at: st.mtimeMs,
    });
  }
  return out;
}

/** Commandes slash Claude (`<dir>/**​/*.md`). Sous-dossiers → namespace `dir:cmd`. */
function scanCommandDir(
  baseDir: string, source: SkillSource, scope: 'global' | 'project',
  editable: boolean, idPrefix = '',
): SkillEntry[] {
  const out: SkillEntry[] = [];
  if (!existsSync(baseDir)) return out;
  for (const file of listMarkdownFiles(baseDir)) {
    const st = safeStat(file);
    if (!st) continue;
    const content = safeRead(file);
    if (content == null) continue;
    const rel = relative(baseDir, file).replace(/\.md$/, '');
    const parts = rel.split(sep);
    const local = parts.join(':');
    const id = idPrefix ? `${idPrefix}:${local}` : local;
    if (!ID_RE.test(id)) continue;
    const { fm, body } = parseFrontmatter(content);
    out.push({
      id,
      title: deriveTitle(content, fm, parts[parts.length - 1]!),
      description: deriveDescription(body, fm),
      source, format: 'claude-cmd', scope,
      path: file, editable,
      allowed_tools: fm.allowed_tools,
      argument_hint: fm.argument_hint,
      model: fm.model,
      size: st.size, updated_at: st.mtimeMs,
    });
  }
  return out;
}

/** Installed plugins: skills + commands under each installPath. */
function scanPlugins(): SkillEntry[] {
  const manifest = safeRead(join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'));
  if (!manifest) return [];
  let parsed: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try { parsed = JSON.parse(manifest); } catch { return []; }
  const out: SkillEntry[] = [];
  for (const [key, installs] of Object.entries(parsed.plugins ?? {})) {
    const pluginName = key.split('@')[0]!; // "code-review@market" → "code-review"
    for (const inst of installs ?? []) {
      const root = inst.installPath;
      if (!root || !existsSync(root)) continue;
      // skills : <root>/skills/ ou <root>/.claude/skills/
      for (const sub of ['skills', join('.claude', 'skills')]) {
        out.push(...scanSkillDir(join(root, sub), 'plugin', 'global', false, pluginName));
      }
      // commands : <root>/commands/ ou <root>/.claude/commands/
      for (const sub of ['commands', join('.claude', 'commands')]) {
        out.push(...scanCommandDir(join(root, sub), 'plugin', 'global', false, pluginName));
      }
    }
  }
  return out;
}

/* ───────────────────────── ROOKS scanner ───────────────────────── */

function scanRooks(): SkillEntry[] {
  const out: SkillEntry[] = [];
  for (const id of listDirs(SKILLS_DIR)) {
    if (!ID_RE.test(id)) continue;
    const file = skillFile(id);
    const st = safeStat(file);
    if (!st) continue;
    const content = safeRead(file);
    if (content == null) continue;
    const { fm, body } = parseFrontmatter(content);
    out.push({
      id,
      title: deriveTitle(content, fm, id),
      description: deriveDescription(body, fm),
      source: 'rooks', format: 'rooks', scope: 'global',
      path: file, editable: true,
      allowed_tools: fm.allowed_tools,
      size: st.size, updated_at: st.mtimeMs,
    });
  }
  return out;
}

/* ───────────────────────── API publique ───────────────────────── */

export type ListOptions = {
  /** cwd of the agent/mission → adds the project's skills/commands. */
  cwd?: string;
  /** Include the plugins (costly: I/O on the plugin cache). Default true. */
  includePlugins?: boolean;
};

/**
 * Aggregates all the sources. Sorts by (source rank, title). Marks as `shadowed`
 * the entries whose id is already provided by a source of higher precedence.
 */
export function listAllSkills(opts: ListOptions = {}): SkillEntry[] {
  const entries: SkillEntry[] = [];
  entries.push(...scanRooks());
  entries.push(...scanSkillDir(join(CLAUDE_HOME, 'skills'), 'claude-user', 'global', true));
  entries.push(...scanCommandDir(join(CLAUDE_HOME, 'commands'), 'claude-user', 'global', true));

  if (opts.cwd) {
    const projSkills = join(opts.cwd, '.claude', 'skills');
    const projCmds = join(opts.cwd, '.claude', 'commands');
    entries.push(...scanSkillDir(projSkills, 'project', 'project', true));
    entries.push(...scanCommandDir(projCmds, 'project', 'project', true));
  }

  if (opts.includePlugins !== false) entries.push(...scanPlugins());

  // Shadowing: for each id, the best source wins; the others are shadowed.
  const best = new Map<string, number>();
  for (const e of entries) {
    const r = SOURCE_RANK[e.source];
    const cur = best.get(e.id);
    if (cur === undefined || r < cur) best.set(e.id, r);
  }
  for (const e of entries) {
    if (SOURCE_RANK[e.source] > (best.get(e.id) ?? 99)) e.shadowed = true;
  }

  return entries.sort((a, b) =>
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
    || a.title.localeCompare(b.title));
}

/** Narrows a lookup to one source (and format), masked entries included. */
export type SkillOrigin = { source: SkillSource; format?: SkillFormat };

/**
 * Resolves an id to the entry of highest precedence (not shadowed), or, with
 * `origin`, to the one from that source: the card of a shadowed skill opens that
 * skill, not the one shadowing it.
 */
export function resolveSkill(id: string, opts: ListOptions & { origin?: SkillOrigin } = {}): SkillEntry | null {
  if (!ID_RE.test(id)) return null;
  const { origin } = opts;
  const matches = listAllSkills(opts).filter((e) => e.id === id && (origin
    ? e.source === origin.source && (!origin.format || e.format === origin.format)
    : !e.shadowed));
  return matches[0] ?? null;
}

/** Reads the raw content of an entry's file. */
export function readEntryContent(entry: SkillEntry): string | null {
  return safeRead(entry.path);
}

/* ───────────────────────── guarded write ───────────────────────── */

/** A path is editable from ROOKS if it lives in a managed root
 *  (ROOKS skills, global Claude skills/commands, or a project's
 *  `.claude/{skills,commands}`) AND NOT in the plugin cache (managed outside ROOKS). */
export function isManagedPath(path: string): boolean {
  const p = resolve(path);
  const pluginsCache = resolve(join(CLAUDE_HOME, 'plugins'));
  if (p.startsWith(pluginsCache + sep)) return false;

  const roots = [
    resolve(join(SKILLS_DIR)),
    resolve(join(CLAUDE_HOME, 'skills')),
    resolve(join(CLAUDE_HOME, 'commands')),
  ];
  if (roots.some((r) => p.startsWith(r + sep))) return true;
  return inProjectClaudeDir(p);
}

/** A project's `…/.claude/skills|commands/<something>`, read by segments of
 *  the host's own separator: a `/` regex never matched a resolved Windows path
 *  (TODO #541), and accepting `\` on POSIX would let one odd file name pass. */
export function inProjectClaudeDir(resolved: string, separator: string = sep): boolean {
  const parts = resolved.split(separator);
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (parts[i] === '.claude' && (parts[i + 1] === 'skills' || parts[i + 1] === 'commands') && parts[i + 2] !== '') return true;
  }
  return false;
}

/** A folder that contains skills (and is not a skill): never deletable. */
function isSkillsRoot(dir: string): boolean {
  if (
    dir === resolve(SKILLS_DIR)
    || dir === resolve(join(CLAUDE_HOME, 'skills'))
    || dir === resolve(join(CLAUDE_HOME, 'commands'))
  ) return true;
  return basename(dirname(dir)) === '.claude' && ['skills', 'commands'].includes(basename(dir));
}

/** Writes the content of a skill/command to a managed path. Refuses outside a root. */
export function writeEntryFile(path: string, content: string, opts: { createOnly?: boolean } = {}): void {
  if (!isManagedPath(path)) throw new Error(`unmanaged path, write refused: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeSkillFile(path, content, opts.createOnly === true, path);
}

/** Deletes the file of a managed skill. For a folder-format skill
 *  (`<id>/SKILL.md`) the parent folder is removed; for a command, the `.md`. */
export function deleteEntryFile(path: string): boolean {
  if (!isManagedPath(path)) throw new Error(`unmanaged path, deletion refused: ${path}`);
  if (!existsSync(path)) return false;
  if (path.endsWith(`${sep}SKILL.md`) || path.endsWith('/SKILL.md')) {
    // `<root>/SKILL.md` has the root itself as its parent: removing "the
    // skill's folder" would wipe every skill of that root.
    if (isSkillsRoot(resolve(dirname(path)))) {
      throw new Error(`refusing to delete a skills root folder: ${dirname(path)}`);
    }
    rmSync(dirname(path), { recursive: true, force: true });
  } else {
    rmSync(path, { force: true });
  }
  return true;
}

/** Path where to create a NEW ROOKS skill (folder format). */
export function rooksSkillPath(id: string): string {
  return join(ROOKS_HOME, 'skills', id, 'SKILL.md');
}

/* ───────────────────────── import into Rooks ───────────────────────── */

/** The sources a mission cannot see, hence the only ones worth importing. */
export type ImportableSource = Extract<SkillSource, 'claude-user' | 'plugin'>;
export const IMPORTABLE_SOURCES = ['claude-user', 'plugin'] as const satisfies readonly ImportableSource[];

/** A skill folder is instructions plus a few scripts or references, not a repository. */
export const IMPORT_MAX_FILES = 200;
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export type SkillImportErrorCode = 'invalid_id' | 'too_large' | 'unreadable';

export class SkillImportError extends Error {
  constructor(message: string, readonly code: SkillImportErrorCode) {
    super(message);
    this.name = 'SkillImportError';
  }
}

/** The Rooks id grammar (`skills.ts`), minus a trailing dot, which Windows drops from a folder name. */
const ROOKS_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function isImportableId(id: string): boolean {
  return ROOKS_ID_RE.test(id) && !id.endsWith('.');
}

/** `code-review:review` → `code-review-review`: a Rooks id has no namespace. */
export function defaultImportId(sourceId: string): string {
  return sourceId.toLowerCase().replace(/:/g, '-');
}

/** The entry `id` of `source`, shadowed or not: the id names it in the registry, never a path from the caller. */
export function findImportableSkill(id: string, source: ImportableSource): SkillEntry | null {
  if (!ID_RE.test(id)) return null;
  return listAllSkills({ includePlugins: source === 'plugin' })
    .find((e) => e.id === id && e.source === source) ?? null;
}

export type SkillImportPlan = {
  entry: SkillEntry;
  /** What becomes `SKILL.md`: the very text the write guard judged. */
  content: string;
  /** The skill folder's other files (scripts, references), relative to it. */
  files: { rel: string; abs: string }[];
  /** What is not copied: links (they would reach out of the skills folder), special files, `.git`. */
  skipped: string[];
};

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** Reads what an import would copy, without writing anything. Throws `SkillImportError`. */
export function planSkillImport(entry: SkillEntry): SkillImportPlan {
  const content = safeRead(entry.path);
  if (content == null) throw new SkillImportError(`cannot read ${entry.path}`, 'unreadable');
  const plan: SkillImportPlan = { entry, content, files: [], skipped: [] };
  // A command is one markdown file; it becomes the skill's SKILL.md.
  if (entry.format !== 'claude-skill') return plan;

  // `<base>/<name>/SKILL.md`: the folder is the skill's own, never a plugin's root.
  const root = dirname(entry.path);
  let count = 1;
  let bytes = Buffer.byteLength(content);
  const walk = (dir: string) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { throw new SkillImportError(`cannot read ${dir}`, 'unreadable'); }
    for (const name of names) {
      const abs = join(dir, name);
      const rel = relative(root, abs);
      // Any case of the root SKILL.md is left out: on a case-insensitive volume
      // (macOS, Windows) `skill.md` IS the entry, already in `content`, and
      // copying it would make the SKILL.md write fail as "already exists".
      // On a case-sensitive one it is a second file the target could not hold.
      if (rel.toLowerCase() === 'skill.md') {
        if (rel !== 'SKILL.md' && !sameFile(abs, entry.path)) plan.skipped.push(rel);
        continue;
      }
      let st: import('node:fs').Stats;
      try { st = lstatSync(abs); } catch { plan.skipped.push(rel); continue; }
      if (st.isDirectory()) {
        if (name === '.git') { plan.skipped.push(rel); continue; }
        walk(abs);
      } else if (st.isFile()) {
        count += 1;
        bytes += st.size;
        if (count > IMPORT_MAX_FILES || bytes > IMPORT_MAX_BYTES) {
          throw new SkillImportError(
            `${entry.id} is too large to import (over ${IMPORT_MAX_FILES} files or ${IMPORT_MAX_BYTES / 1024 / 1024} MB)`,
            'too_large',
          );
        }
        plan.files.push({ rel, abs });
      } else {
        plan.skipped.push(rel);
      }
    }
  };
  walk(root);
  return plan;
}

/**
 * Copies the planned skill into `~/.rooks/skills/<id>/`. Never replaces: the
 * folder is claimed with a non-recursive `mkdir`, so two imports of one id
 * cannot both win, and an existing skill raises `SkillExistsError`. A copy
 * that fails half-way leaves nothing behind.
 */
export function importSkill(plan: SkillImportPlan, id: string): { id: string; path: string; files: number; skipped: string[] } {
  if (!isImportableId(id)) throw new SkillImportError(`invalid skill id: ${id}`, 'invalid_id');
  mkdirSync(SKILLS_DIR, { recursive: true });
  const dir = join(SKILLS_DIR, id);
  try {
    mkdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new SkillExistsError(id);
    throw err;
  }
  try {
    for (const file of plan.files) {
      const dest = join(dir, file.rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(file.abs, dest, fsConstants.COPYFILE_EXCL);
    }
    const target = join(dir, 'SKILL.md');
    writeSkillFile(target, plan.content, true, id);
    return { id, path: target, files: plan.files.length + 1, skipped: plan.skipped };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
