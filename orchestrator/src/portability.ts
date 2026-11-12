/**
 * Makes a `~/.rooks` portable from one machine to another.
 *
 * 79 agent `config.json` files contain `/home/<user>/…` in their `cwd`, the
 * project `meta.json` files too, and the MCP servers carry absolute paths
 * in their command, their arguments and their environment. Exported as is,
 * a `~/.rooks` restarts on no other machine (nor under another user
 * name, nor on macOS where the home is not `/home/<user>`).
 *
 * The rewrite is textual and bounded to the fields listed here: we do not read
 * the whole JSON again looking for paths. A wrong `cwd` breaks an
 * agent loudly; a memo rewritten askew goes unnoticed.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandPath, portablePath } from './paths.js';

export type RewriteMode = 'export' | 'import';

export type RewriteChange = {
  file: string;
  field: string;
  from: string;
  to: string;
};

export type RewriteReport = {
  mode: RewriteMode;
  changes: RewriteChange[];
  /** Files actually rewritten (empty in dry-run). */
  written: string[];
};

function transform(mode: RewriteMode, value: string): string {
  return mode === 'export' ? portablePath(value) : expandPath(value);
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function listDir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Walks `dir` (a `~/.rooks`, real or extracted from an archive) and rewrites the
 * absolute paths. Dry-run by default: nothing is written as long as `write` is
 * not true. The report lists each field touched — it is what
 * `rooks export` / `rooks import` display.
 */
export function rewriteAbsolutePaths(
  dir: string,
  mode: RewriteMode,
  opts: { write?: boolean } = {},
): RewriteReport {
  const changes: RewriteChange[] = [];
  const written: string[] = [];

  const apply = (file: string, mutate: (obj: Record<string, unknown>) => boolean): void => {
    const obj = readJson(file);
    if (!obj) return;
    if (!mutate(obj)) return;
    if (opts.write) {
      writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
      written.push(file);
    }
  };

  const rewriteField = (
    file: string,
    obj: Record<string, unknown>,
    field: string,
  ): boolean => {
    const value = obj[field];
    if (typeof value !== 'string' || !value) return false;
    const next = transform(mode, value);
    if (next === value) return false;
    changes.push({ file, field, from: value, to: next });
    obj[field] = next;
    return true;
  };

  // agents/<nom>/config.json → cwd
  const agentsDir = join(dir, 'agents');
  for (const name of listDir(agentsDir)) {
    const file = join(agentsDir, name, 'config.json');
    apply(file, (obj) => rewriteField(file, obj, 'cwd'));
  }

  // projects/<slug>/meta.json → cwd
  const projectsDir = join(dir, 'projects');
  for (const slug of listDir(projectsDir)) {
    const file = join(projectsDir, slug, 'meta.json');
    apply(file, (obj) => rewriteField(file, obj, 'cwd'));
  }

  // mcp/<id>.json → transport.command, transport.args[], transport.env{}
  const mcpDir = join(dir, 'mcp');
  if (isDir(mcpDir)) {
    for (const entry of listDir(mcpDir)) {
      if (!entry.endsWith('.json')) continue;
      const file = join(mcpDir, entry);
      apply(file, (obj) => {
        const transport = obj['transport'];
        if (!transport || typeof transport !== 'object' || Array.isArray(transport)) return false;
        const t = transport as Record<string, unknown>;
        let touched = false;

        if (rewriteField(file, t, 'command')) touched = true;

        const args = t['args'];
        if (Array.isArray(args)) {
          args.forEach((arg, i) => {
            if (typeof arg !== 'string' || !arg) return;
            const next = transform(mode, arg);
            if (next === arg) return;
            changes.push({ file, field: `transport.args[${i}]`, from: arg, to: next });
            args[i] = next;
            touched = true;
          });
        }

        const env = t['env'];
        if (env && typeof env === 'object' && !Array.isArray(env)) {
          for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
            if (typeof v !== 'string' || !v) continue;
            const next = transform(mode, v);
            if (next === v) continue;
            changes.push({ file, field: `transport.env.${k}`, from: v, to: next });
            (env as Record<string, unknown>)[k] = next;
            touched = true;
          }
        }
        return touched;
      });
    }
  }

  return { mode, changes, written };
}
