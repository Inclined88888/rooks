/**
 * Fact capture at the end of a mission (mechanism 2/3 of the self-learning
 * memory system). On each `mission_complete` (completed OR failed), extracts
 * via a cheap LLM (Haiku, without spawning a full agent) the decisions /
 * pitfalls / preferences of the transcript, and inserts them raw (status `raw`) into
 * the `learnings` table (DB). NOT injected as is: the nightly synthesiser
 * (mechanism 3) generalises them into candidate rules, and the recall
 * surfaces the recent raw pitfalls.
 *
 * Gating: env `ROOKS_FACT_CAPTURE_ENABLED=1` (default off), ≥3 user turns,
 * doc/librarian missions are skipped (archiving, no lesson). `oneShotPrompt`
 * creates no mission, no event and no bus traffic → no risk of a loop.
 *
 * Idempotency: dbApi.missionHasLearnings(missionId) before capture.
 */
import { createHash } from 'node:crypto';
import type { BusEvent } from './bus.js';
import { bus } from './bus.js';
import { dbApi } from './db.js';
import {
  loadConfig, projectFromCwd, type AgentConfig,
} from './agent.js';
import { renderTranscript, oneShotPrompt } from './summary.js';
import { settingBool, settingStr } from './settings.js';
import { oneShotTarget } from './backends/index.js';

const LIBRARIAN_NAME = 'ROOKS.librarian';
const MIN_USER_TURNS = 3;
const TRANSCRIPT_CHAR_CAP = 12_000;
const MAX_FACTS = 8;

type FactKind = 'decision' | 'pitfall' | 'preference';
type Fact = { kind: FactKind; text: string };

const CAPTURE_SYSTEM_PROMPT = `You extract the REUSABLE LESSONS from the transcript of an agent mission (dev/ops).
You produce ONLY a JSON array, nothing else. Strict format:
[{"kind":"decision|pitfall|preference","text":"..."}]

- decision: a non-obvious technical choice and its why (e.g. "We keep X rather than Y because Z").
- pitfall: a mistake made / a trap met that must not happen again (e.g. "The API returns 200 even on partial failure, check body.field").
- preference: an explicit preference/instruction of the user about how to work.

Hard rules:
- At most ${MAX_FACTS} items, the most useful ones. Prefer 0 to filler.
- Each "text": one concise, self-contained, actionable sentence, in the language the user speaks in the transcript.
- IGNORE anything derivable from git/logs or trivial (formatting, "I read the file", expected successes).
- Invent nothing: only what the transcript supports.
- If nothing is useful: answer exactly "[]".
Put no text outside the JSON array.`;

function normalizeHash(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 12);
}

export function parseFacts(out: string): Fact[] {
  // tolerates a possible ```json … ``` block around the array
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = (fenced ? fenced[1]! : out).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let arr: unknown;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const facts: Fact[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const kind = o.kind;
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if ((kind === 'decision' || kind === 'pitfall' || kind === 'preference') && text) {
      facts.push({ kind, text });
    }
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}

async function captureMission(missionId: string): Promise<void> {
  const mission = dbApi.getMission(missionId);
  if (!mission) return;
  const agent = mission.agent_name;

  // Skip archiving / system missions (no lesson, and avoids wasting the LLM).
  if (agent === LIBRARIAN_NAME) return;
  const task = dbApi.getTaskByMission(missionId);
  if (task && task.type === 'doc') return;

  if (dbApi.countUserTurns(missionId) < MIN_USER_TURNS) return;
  if (dbApi.missionHasLearnings(missionId)) return;

  const transcript = renderTranscript(dbApi.listEvents(missionId));
  if (!transcript.trim()) return;
  const capped = transcript.length > TRANSCRIPT_CHAR_CAP
    ? transcript.slice(-TRANSCRIPT_CHAR_CAP)
    : transcript;

  let cfg: AgentConfig;
  try { cfg = loadConfig(agent); } catch { return; }
  // The capture runs on the provider that serves the daemon's own tasks, whatever the agent's backend is.
  const captureCfg: AgentConfig = { ...cfg, ...oneShotTarget(settingStr('ROOKS_FACT_CAPTURE_MODEL')) };

  let out: string;
  try {
    out = await oneShotPrompt(agent, captureCfg, `# Mission transcript\n\n${capped}`, CAPTURE_SYSTEM_PROMPT);
  } catch (err) {
    console.warn(`[memory-capture] extraction failed ${missionId.slice(0, 8)}: ${(err as Error).message}`);
    return;
  }
  const facts = parseFacts(out);
  if (facts.length === 0) return;

  const project = cfg.project ?? projectFromCwd(cfg.cwd);
  const role = cfg.role ?? null;
  const ts = Date.now();
  const batchSeen = new Set<string>();

  let n = 0;
  for (const f of facts) {
    const hash = normalizeHash(f.text);
    if (batchSeen.has(hash)) continue; // same fact repeated within one extraction
    batchSeen.add(hash);
    // Raw facts → learnings table (status raw). The nightly synthesiser
    // generalises them into candidate rules; the recent raw pitfalls are also
    // surfaced at recall (recentPitfalls) while waiting for the synthesis.
    dbApi.insertLearning({ missionId, agent, project, role, kind: f.kind, text: f.text, hash, ts });
    n++;
  }
  if (n === 0) return;
  console.log(`[memory-capture] ${missionId.slice(0, 8)} (${agent}): +${n} fact(s) → learnings`);
}

export function startMemoryCapture(): () => void {
  if (!settingBool('ROOKS_FACT_CAPTURE_ENABLED')) {
    console.log('[memory-capture] disabled (ROOKS_FACT_CAPTURE_ENABLED != 1)');
    return () => { /* nothing was started */ };
  }
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind !== 'mission_complete') return;
    // completed AND failed: pitfalls are often born in failures.
    captureMission(ev.missionId).catch((err) => {
      console.error(`[memory-capture] handler error ${ev.missionId}: ${(err as Error).message}`);
    });
  };
  bus.on('event', onBusEvent);
  console.log('[memory-capture] fact capture enabled (completed+failed)');
  return () => void bus.off('event', onBusEvent);
}
