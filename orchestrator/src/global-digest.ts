/**
 * Cross-project digest injected at the spawn of `global_context=true` agents
 * (`_main` orchestrators, business agents that orchestrate priorities).
 *
 * Assembled WITHOUT an LLM: `projects` table (hot/cold via status + last_activity)
 * + front-matter/summary of the vault notes `wiki/projects/<slug>/_index.md` +
 * hand-edited objectives (`~/.rooks/memory/objectives.md`). Sorted by freshness,
 * bounded in size → the agent permanently "knows" the landscape without carrying
 * the whole vault in context (progressive disclosure: it reads the full note on
 * demand). Best-effort: no read may make a spawn fail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configuredVaultRoot } from './vault-root.js';
import { join } from 'node:path';
import { dbApi, type ProjectRow } from './db.js';
import { GLOBAL_MEMORY_DIR } from './paths.js';
import { settingNum, settingStr } from './settings.js';

const FOCUS_CAP = 180;


const OBJECTIVES_FILE = join(GLOBAL_MEMORY_DIR, 'objectives.md');

const OBJECTIVES_PLACEHOLDER = '- (to fill in)';
/** The placeholder of the French template written before TODO #628. */
// french-ok: matches objectives.md files written by the old French template
const LEGACY_OBJECTIVES_PLACEHOLDER = '- (à remplir)';

const OBJECTIVES_TEMPLATE = `# My objectives

<!-- Edited by hand. Injected at the top of the digest of global_context=true agents.
     Describe what you want to move forward on (life, priority projects, constraints).
     An orchestration agent uses it to tell you what to prioritise. -->

${OBJECTIVES_PLACEHOLDER}
`;

/** The template's placeholder, still unfilled. Also recognises the French one
 *  written by daemons before TODO #628: those files are never rewritten. */
export function isObjectivesPlaceholder(body: string): boolean {
  const t = body.trim();
  return t.endsWith(OBJECTIVES_PLACEHOLDER) || t.endsWith(LEGACY_OBJECTIVES_PLACEHOLDER);
}

/** Creates the objectives.md template if it does not exist. Called at boot. */
export function seedObjectives(): void {
  try {
    if (existsSync(OBJECTIVES_FILE)) return;
    mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
    writeFileSync(OBJECTIVES_FILE, OBJECTIVES_TEMPLATE);
  } catch { /* best-effort */ }
}

function readObjectives(): string | null {
  try {
    if (!existsSync(OBJECTIVES_FILE)) return null;
    const raw = readFileSync(OBJECTIVES_FILE, 'utf8');
    // retire titre + commentaires HTML de gabarit
    const body = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^#.*$/m, '').trim();
    if (!body || body === OBJECTIVES_PLACEHOLDER || body === LEGACY_OBJECTIVES_PLACEHOLDER) return null;
    // Generous cap: the objectives are the heart of the digest (the total cap of 2500 bounds
    // the whole). We do not want to trim the strategy before the project cards.
    const cap = 1400;
    return body.length > cap ? body.slice(0, cap) + '…' : body;
  } catch { return null; }
}

/** Extracts a short focus from the project's vault note (outside the front-matter). */
function brainFocus(slug: string): string | null {
  try {
    const root = configuredVaultRoot();
    if (!root) return null;
    const path = join(root, 'wiki', 'projects', slug, '_index.md');
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');
    for (const para of raw.split(/\n\s*\n/)) {
      const t = para.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
      if (t.length > 20) return t.length > FOCUS_CAP ? t.slice(0, FOCUS_CAP) + '…' : t;
    }
  } catch { /* ignore */ }
  return null;
}

function relativeTime(ts: number | null, now: number): string {
  if (!ts) return 'never';
  const d = now - ts;
  const day = 86400_000;
  if (d < day) return 'today';
  const days = Math.round(d / day);
  return `${days}d ago`;
}

function scoreLine(r: ProjectRow): string | null {
  if (r.revenue_potential == null && r.progress == null) return null;
  const rev = r.revenue_potential == null ? '?' : `${r.revenue_potential}/100`;
  const prog = r.progress == null ? '?' : `${r.progress}%`;
  const lock = r.revenue_locked === 1 ? ' (locked)' : '';
  return `   💰 revenue ${rev}${lock} · 📊 progress ${prog}`;
}

function renderCard(r: ProjectRow, now: number): string {
  const tag = [r.kind, r.status].filter(Boolean).join(' · ');
  const head = `[${tag}] ${r.slug}${r.speech ? ` — ${r.speech}` : ''}`;
  const focus = brainFocus(r.slug);
  const lines = [head];
  if (focus) lines.push(`   ${focus}`);
  const score = scoreLine(r);
  if (score) lines.push(score);
  lines.push(`   · ${relativeTime(r.last_activity, now)}`);
  return lines.join('\n');
}

/**
 * Builds the digest. Returns '' if there is nothing to show (no hot project and no
 * objectives). `now` injectable for the tests.
 */
export function buildGlobalDigest(now: number = Date.now()): string {
  let rows: ProjectRow[];
  try { rows = dbApi.listProjectRows(); } catch { return ''; }
  const active = rows.filter((r) => (r.status ?? 'active') === 'active');
  // All the "recent" projects (activity < settingNum('ROOKS_DIGEST_HOT_DAYS')), sorted from hottest to
  // coldest. The first settingNum('ROOKS_DIGEST_HOT_MAX') are shown; the rest of this list is
  // still active (not dormant) → it is summarised by name, and the truly dormant
  // projects (no recent activity) are counted separately.
  const recent = active
    .filter((r) => r.last_activity != null && now - r.last_activity <= settingNum('ROOKS_DIGEST_HOT_DAYS') * 86400_000)
    .sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0));
  const hot = recent.slice(0, settingNum('ROOKS_DIGEST_HOT_MAX'));
  const otherActive = recent.slice(settingNum('ROOKS_DIGEST_HOT_MAX'));
  const dormant = rows.length - recent.length;

  const objectives = readObjectives();
  const sections: string[] = [];
  if (objectives) sections.push(`## Your objectives\n${objectives}`);
  if (hot.length) {
    const cards = hot.map((r) => renderCard(r, now)).join('\n\n');
    let body = `## Hot projects\n${cards}`;
    if (otherActive.length) {
      body += `\n\n+ other active projects: ${otherActive.map((r) => r.slug).join(', ')}`;
    }
    if (dormant > 0) body += `\n\n+ ${dormant} dormant project(s) (vault details on request)`;
    sections.push(body);
  }
  if (!sections.length) return '';

  let out = `\n\n---\n# 🗺️ Cross-project context\n\n${sections.join('\n\n')}\n`;
  if (out.length > settingNum('ROOKS_DIGEST_CHAR_CAP')) out = out.slice(0, settingNum('ROOKS_DIGEST_CHAR_CAP')) + '\n… [digest truncated]\n';
  return out;
}
