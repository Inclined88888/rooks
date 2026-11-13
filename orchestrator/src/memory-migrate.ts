/**
 * Idempotent files → DB backfill (migration of project memory/meta).
 *
 * Called once at boot (index.ts), BEFORE anything reads
 * memory. Each section is guarded to run only once:
 *   - projects   : per slug (upsert if the row does not exist)
 *   - learnings  : global (if the table is empty)
 *   - memory_rules : global (if the table is empty)
 *
 * The source files stay in place (dormant) — backup, later manual
 * deletion. The knowledge vault is NOT concerned (stays Markdown).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_DIR, PROJECTS_DIR, agentMemoryFile, projectMemoryFile } from './paths.js';
import { dbApi } from './db.js';
import { readMetaFile } from './projects.js';

const SLUG_RE = /^[A-Za-z0-9._-]{1,64}$/;

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (!SLUG_RE.test(name) && !/^[\w.@-]+$/.test(name)) return false;
    try { return statSync(join(dir, name)).isDirectory(); } catch { return false; }
  });
}

/** Extracts the markdown list items (`- …` / `* …`), ignores comments/headings. */
function parseListItems(md: string): string[] {
  const out: string[] = [];
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('- ') && !line.startsWith('* ')) continue;
    const text = line.slice(2).trim();
    if (text && !text.startsWith('<!--')) out.push(text);
  }
  return out;
}

export function backfillMemoryFromFiles(): void {
  let projN = 0;
  let learnN = 0;
  let ruleN = 0;

  // ── 1. projects: file meta → DB (per slug) ─────────────────────────────────
  for (const slug of listSubdirs(PROJECTS_DIR)) {
    if (!SLUG_RE.test(slug)) continue;
    if (dbApi.getProjectRow(slug)) continue;
    const meta = readMetaFile(slug) ?? {};
    dbApi.upsertProject(slug, {
      name: meta.name ?? undefined, color: meta.color ?? undefined, icon: meta.icon ?? undefined,
      workspace: meta.workspace ?? undefined, cwd: meta.cwd ?? undefined, speech: meta.speech ?? undefined,
      kind: meta.kind ?? undefined, status: meta.status ?? undefined,
    });
    projN++;
  }

  // ── 2. learnings.jsonl → learnings table (if empty) ─────────────────────────
  const maxTsByProject = new Map<string, number>();
  if (dbApi.countLearnings() === 0) {
    for (const agent of listSubdirs(AGENTS_DIR)) {
      const f = agentMemoryFile(agent, 'learnings.jsonl');
      if (!existsSync(f)) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let j: Record<string, unknown>;
        try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (typeof j.kind !== 'string' || typeof j.text !== 'string' || !j.text) continue;
        const ts = typeof j.ts === 'string' ? (Date.parse(j.ts) || Date.now()) : Date.now();
        const project = typeof j.project === 'string' ? j.project : null;
        dbApi.insertLearning({
          missionId: typeof j.missionId === 'string' ? j.missionId : null,
          agent: typeof j.agent === 'string' ? j.agent : agent,
          project, role: typeof j.role === 'string' ? j.role : null,
          kind: j.kind, text: j.text, hash: typeof j.hash === 'string' ? j.hash : null, ts,
        });
        learnN++;
        if (project) maxTsByProject.set(project, Math.max(maxTsByProject.get(project) ?? 0, ts));
      }
    }
    // Seed last_activity from the learnings (proxy; the bus corrects it afterwards).
    for (const [slug, ts] of maxTsByProject) {
      if (SLUG_RE.test(slug)) dbApi.touchProjectActivity(slug, ts);
    }
  }

  // ── 3. instructions/decisions/pieges → memory_rules (if empty) ─────────────
  //
  // WARNING — this import is a ONE-SHOT BOOTSTRAP, not a resync.
  // The `length === 0` guard is only true once in the life of a database:
  // from the first rule inserted (here, by the curator, or by hand),
  // this branch NEVER runs again. That is on purpose — replaying
  // the import would recreate, at every start, the rules the curator has
  // superseded or archived.
  //
  // Corollary not to forget: writing into `pieges.md` / `instructions.md` /
  // `decisions.md` no longer injects anything into agents. The living gesture to
  // memorise is `rooks memory rule add` (→ POST /api/memory/rules), which writes
  // directly into `memory_rules`.
  if (dbApi.listRules().length === 0) {
    // per-agent pieges.md → scope=agent rules
    for (const agent of listSubdirs(AGENTS_DIR)) {
      const pg = agentMemoryFile(agent, 'pieges.md');
      if (!existsSync(pg)) continue;
      for (const text of parseListItems(readFileSync(pg, 'utf8'))) {
        dbApi.insertRule({ scope: 'agent', agent, kind: 'pitfall', text, source: 'manual' });
        ruleN++;
      }
    }
    // per-project instructions/decisions → scope=project rules
    for (const slug of listSubdirs(PROJECTS_DIR)) {
      if (!SLUG_RE.test(slug)) continue;
      for (const [file, kind] of [['decisions.md', 'decision'], ['instructions.md', 'preference']] as const) {
        const p = projectMemoryFile(slug, file);
        if (!existsSync(p)) continue;
        for (const text of parseListItems(readFileSync(p, 'utf8'))) {
          dbApi.insertRule({ scope: 'project', project: slug, kind, text, source: 'manual' });
          ruleN++;
        }
      }
    }
  }

  if (projN || learnN || ruleN) {
    console.log(`[memory-migrate] backfill: ${projN} projects, ${learnN} learnings, ${ruleN} rules`);
  }
}
