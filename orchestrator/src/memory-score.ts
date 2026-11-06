/**
 * Project scorer (feeds the cross-project digest + the advisor agent).
 *
 * For each ACTIVE project, estimates two numbers 0-100:
 *  - `revenue_potential`: PASSIVE revenue potential, judged against the user's
 *    GRID (`objectives.md`) — not the absolute business value, but the alignment
 *    with their ultimate goal (SaaS/trading/social→funnels = high; client service
 *    dev/SEO = low because a non-scalable means). Overwritten only if `revenue_locked=0`.
 *  - `progress`: real progress towards a product that runs/earns.
 *
 * Why a job SEPARATE from the synthesis (and not merged into it): the synthesis only
 * runs on projects with recent raw facts (= recent missions).
 * Yet the heart of the anti-ADHD use is the almost-finished DORMANT project — which has
 * no raw facts. Merging it into the synthesis would make the scoring blind to
 * exactly what the advisor agent must flag. A distinct job, but cheap: staleness gate
 * (re-score only if activity is more recent than the last score) + credit
 * spacing + nightly window AFTER the synthesis (never 2 Sonnet passes in a heap).
 *
 * One-shot Sonnet per project, under a CLI subscription (not the API).
 */
import { existsSync, readFileSync } from 'node:fs';
import { configuredVaultRoot } from './vault-root.js';
import { join } from 'node:path';
import { dbApi, type ProjectRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent.js';
import { readMeta } from './projects.js';
import { oneShotPrompt } from './summary.js';
import { GLOBAL_MEMORY_DIR } from './paths.js';
import { settingBool, settingNum, settingStr } from './settings.js';
import { oneShotTarget } from './backends/index.js';
import { isObjectivesPlaceholder } from './global-digest.js';

const TICK_MS = 30 * 60_000;


const OBJECTIVES_FILE = join(GLOBAL_MEMORY_DIR, 'objectives.md');
const INDEX_CAP = 3000;

type Score = { revenue_potential: number | null; progress: number | null; rationale: string | null };

const SCORE_SYSTEM_PROMPT = `You are a business analyst working for the user. You are given (1) their PROFITABILITY GRID (their objectives/life priorities), and (2) the sheet of ONE project (metadata + vault note). Estimate two integers 0-100.

revenue_potential = revenue potential for the user, JUDGED AGAINST THEIR GRID — not the absolute business value in the abstract, but the alignment with THEIR ultimate goal:
- HIGH (70-100): SaaS, trading bot, automated social media management → sales funnels, or any scalable/recurring/passive revenue.
- MEDIUM (30-60): a project with active but not yet passive revenue, or a high-leverage internal tool.
- LOW (0-30): client web dev/SEO work (short-term cash flow = MEDIUM, not the goal), a project without an identifiable revenue model, a personal tool that cannot be monetised.

progress = real progress towards a product that RUNS and can earn: 0 = a mere idea, 30 = prototype, 60 = working MVP not monetised, 80 = in production close to cash, 100 = already in production and earning. Estimate from the described state (milestones reached, what works vs what is missing). If the sheet is thin, estimate cautiously and say so.

Answer ONLY with a strict JSON object, nothing else:
{"revenue_potential": N, "progress": N, "rationale": "1-2 sentences, in the language the objectives are written in, justifying BOTH numbers; say so if the estimate is uncertain for lack of information"}`;

function clamp01(n: unknown): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseScore(out: string): Score | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = (fenced ? fenced[1]! : out).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  const rev = clamp01(obj.revenue_potential);
  const prog = clamp01(obj.progress);
  if (rev === null && prog === null) return null;
  return {
    revenue_potential: rev,
    progress: prog,
    rationale: typeof obj.rationale === 'string' ? obj.rationale.trim().slice(0, 400) : null,
  };
}

function baseCfg(slug: string): { name: string; cfg: AgentConfig } {
  let cfg: AgentConfig;
  try { cfg = loadConfig(settingStr('TIMON_SCORE_AGENT')); } catch { cfg = {}; }
  const cwd = readMeta(slug).cwd ?? cfg.cwd;
  return { name: settingStr('TIMON_SCORE_AGENT'), cfg: { ...cfg, ...oneShotTarget(settingStr('TIMON_SCORE_MODEL')), cwd: cwd ?? undefined } };
}

const NO_OBJECTIVES = '(no objectives filled in)';

function readObjectivesFull(): string {
  try {
    if (!existsSync(OBJECTIVES_FILE)) return NO_OBJECTIVES;
    const body = readFileSync(OBJECTIVES_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    return body && !isObjectivesPlaceholder(body) ? body : NO_OBJECTIVES;
  } catch { return NO_OBJECTIVES; }
}

function readBrainIndex(slug: string): string {
  try {
    const root = configuredVaultRoot();
    if (!root) return '(vault not configured)';
    const path = join(root, 'wiki', 'projects', slug, '_index.md');
    if (!existsSync(path)) return '(no vault note for this project)';
    const raw = readFileSync(path, 'utf8');
    return raw.length > INDEX_CAP ? raw.slice(0, INDEX_CAP) + '\n… [truncated]' : raw;
  } catch { return '(no vault note for this project)'; }
}

function relativeTime(ts: number | null, now: number): string {
  if (!ts) return 'never';
  const days = Math.round((now - ts) / 86400_000);
  return days < 1 ? 'today' : `${days}d ago`;
}

/** Should this project be (re)scored? Freshness gate to stay cheap. */
function needsScoring(r: ProjectRow, now: number, force: boolean): boolean {
  if ((r.status ?? 'active') !== 'active') return false;
  if (force) return true;
  if (r.score_updated_at == null) return true; // never scored
  if (r.last_activity != null && r.last_activity > r.score_updated_at) return true; // activity since
  if (now - r.score_updated_at > settingNum('TIMON_SCORE_STALE_DAYS') * 86400_000) return true; // stale
  return false;
}

async function scoreProject(slug: string, objectives: string, now: number): Promise<boolean> {
  const meta = dbApi.getProjectRow(slug);
  if (!meta) return false;
  const userMsg = `# The user's profitability grid (their objectives)\n${objectives}\n\n` +
    `# Project: ${slug}\n` +
    `kind=${meta.kind ?? '?'} · status=${meta.status} · last activity ${relativeTime(meta.last_activity, now)}\n` +
    `speech: ${meta.speech ?? '(none)'}\n\n` +
    `## Vault note (wiki/projects/${slug}/_index.md)\n${readBrainIndex(slug)}`;

  const { name, cfg } = baseCfg(slug);
  let out: string;
  try {
    out = await oneShotPrompt(name, cfg, userMsg, SCORE_SYSTEM_PROMPT);
  } catch (err) {
    console.warn(`[score] ${slug}: estimate failed — ${(err as Error).message}`);
    return false;
  }
  const score = parseScore(out);
  if (!score) {
    console.warn(`[score] ${slug}: unparsable answer, ignored`);
    return false;
  }
  dbApi.updateProjectScore(slug, score, now);
  const locked = meta.revenue_locked === 1;
  console.log(`[score] ${slug}: rev=${locked ? meta.revenue_potential + '(locked)' : score.revenue_potential} prog=${score.progress}`);
  return true;
}

/** Scoring pass over all the eligible active projects. */
export async function runScoringPass(force = false): Promise<{ scored: number; skipped: number }> {
  const now = Date.now();
  const objectives = readObjectivesFull();
  const rows = dbApi.listProjectRows();
  const targets = rows.filter((r) => needsScoring(r, now, force));
  if (!targets.length) {
    console.log('[score] no project to (re)score');
    return { scored: 0, skipped: rows.length };
  }
  console.log(`[score] pass: ${targets.length} project(s) to score (force=${force})`);
  let scored = 0;
  for (const r of targets) {
    try { if (await scoreProject(r.slug, objectives, now)) scored++; }
    catch (err) { console.error(`[score] error ${r.slug}: ${(err as Error).message}`); }
    await new Promise((res) => setTimeout(res, settingNum('TIMON_SCORE_SPACING_MS')));
  }
  console.log(`[score] pass finished: ${scored}/${targets.length} scored`);
  return { scored, skipped: rows.length - targets.length };
}

export function startProjectScorer(): () => void {
  if (!settingBool('TIMON_SCORE_ENABLED')) {
    console.log('[score] disabled (TIMON_SCORE_ENABLED=0)');
    return () => { /* nothing was started */ };
  }
  let lastRunDay = '';
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const h = now.getHours();
    if (day === lastRunDay) return;
    if (h < settingNum('TIMON_SCORE_HOUR') || h >= settingNum('TIMON_SCORE_HOUR') + settingNum('TIMON_SCORE_WINDOW_H')) return;
    lastRunDay = day;
    runScoringPass(false).catch((err) => console.error(`[score] pass failed: ${(err as Error).message}`));
  };
  const timer = setInterval(tick, TICK_MS);
  console.log(`[score] active (window ${settingNum('TIMON_SCORE_HOUR')}h–${settingNum('TIMON_SCORE_HOUR') + settingNum('TIMON_SCORE_WINDOW_H')}h, model ${settingStr('TIMON_SCORE_MODEL')})`);
  return () => clearInterval(timer);
}

/** Backfill / manual trigger (debug endpoint). force=true = score everything. */
export async function runScoringNow(force = true): Promise<{ scored: number; skipped: number }> {
  return runScoringPass(force);
}
