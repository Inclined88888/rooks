/**
 * The conversion mission of a browser recording (TODO #461), recognised from
 * its token. It reads a recording made of page data nobody vouches for, so an
 * injection in a label could steer it: its token reaches a closed list of
 * routes (#467, `rejectConversionRoute`, applied by the auth middleware), and
 * on those, what it writes is bounded again — one new `browser-*` skill
 * (`skills-mcp-guard.ts`, #466), a read-only browser (`conversionBrowserRefusal`),
 * questions but no other form (`conversionFormRefusal`). Its CLI runs no shell and
 * reads or writes no file (#469, #471), and reaches no MCP server but Timon's: launched
 * that way (`isConversionSource`, `conversionBackendRefusal`), and no card for such a
 * tool (`conversionToolCardRefusal`).
 */
import type { Request, Response } from 'express';
import { dbApi } from '../db.js';
import { findBrowserRecordingByLearnMission, readBrowserRecordingSteps, type BrowserRecordingMetadata, type RecordedStep } from '../browser-recordings.js';
import { BROWSER_SNAPSHOT_SCRIPT } from '../browser-snapshot-script.js';
import { loadConfig } from '../agent-config.js';
import { defaultBackendName } from '../backends/index.js';
import { backendRunsReadOnlyTools } from '../backends/registry.js';
import { ASK_MCP_SERVER, LEGACY_ASK_MCP_SERVER, isFormCardTool } from '../ask-mcp.js';
import { CHROME_DEVTOOLS_MCP_KEY } from '../browser-mcp.js';
import { forbidden } from './identity.js';

/** A conversion mission, its agent, and the recording it converts (null once that recording was deleted). */
export type ConversionMission = { missionId: string; agent: string | null; recording: BrowserRecordingMetadata | null };

/**
 * The conversion mission of a browser recording carrying this request, or null.
 *
 * That mission reads a recording made of page data nobody vouches for: an
 * injection in it could steer the mission into rewriting one of the user's
 * skills, an instruction that would then persist into every later mission
 * loading it. So its token writes ONE new `browser-*` skill (create-only,
 * imposed by the route) and nothing else: no delete, no other id, no free path,
 * no second skill. The recording keeps the id it created (`learnedSkillId`).
 */
export function conversionMissionOf(req: Request): ConversionMission | null {
  if (!isMissionToken(req)) return null;
  // Once per request: the auth middleware asks first, the routes it lets through ask again.
  if (resolved.has(req)) return resolved.get(req)!;
  const conversion = conversionMissionById(req.auth!.missionId!);
  resolved.set(req, conversion);
  return conversion;
}

const resolved = new WeakMap<Request, ConversionMission | null>();

/** `conversionMissionOf` for a mission id: one mission row and at most two key reads. */
export function conversionMissionById(missionId: string): ConversionMission | null {
  const mission = dbApi.getMission(missionId);
  const agent = mission?.agent_name ?? null;
  const named = recordingNamedBy(mission?.source_meta);
  const recording = findBrowserRecordingByLearnMission(missionId, named);
  if (recording) return { missionId, agent, recording };
  // Its recording deleted while it runs, it has still read untrusted page data.
  return named !== null ? { missionId, agent, recording: null } : null;
}

/**
 * Whether a mission's spawn source names a browser recording: the conversion mission the Learn
 * route starts. Read from the mission row at every turn (`spawnTurn`), so the launch stays bounded
 * on a resume, a relaunch or a quota fallback. A mission forging that field only bounds itself.
 */
export function isConversionSource(sourceMeta: string | null | undefined): boolean {
  return recordingNamedBy(sourceMeta) !== null;
}

export const CONVERSION_BACKEND_REFUSAL = 'this backend cannot run a recording conversion safely: '
  + 'it cannot be launched without a shell and without file writes';

/**
 * Refusal for running a conversion on backend `id`, or null. Only a dialect the product declares
 * able to launch with no shell and no write (`readOnlyTools`) may: anything else would leave the
 * CLI's own `Bash` / `Write` to an injection read in the recording (TODO #469).
 */
export function conversionBackendRefusal(backendId: string | null | undefined): string | null {
  return backendRunsReadOnlyTools(backendId || defaultBackendName()) ? null : CONVERSION_BACKEND_REFUSAL;
}

/** `conversionBackendRefusal` for the backend agent `agent` runs on (its config; the default when it names none). */
export function conversionAgentRefusal(agent: string): string | null {
  let backend: string | undefined;
  try { backend = loadConfig(agent).backend; } catch { return CONVERSION_BACKEND_REFUSAL; }
  return conversionBackendRefusal(backend);
}

/** The spawn of a conversion names its recording in the mission's source (`browser-recording/routes.ts`). */
function recordingNamedBy(sourceMeta: string | null | undefined): string | null {
  if (!sourceMeta) return null;
  try {
    const meta = JSON.parse(sourceMeta) as { browser_recording_id?: unknown } | null;
    return typeof meta?.browser_recording_id === 'string' ? meta.browser_recording_id : null;
  } catch {
    return null;
  }
}

/**
 * A request carried by the token of one running mission (an agent), whoever
 * launched it. Its token goes to the agent's context and prompt, so what it may
 * read is bounded more tightly than what a human in a session may.
 */
export function isMissionToken(req: Request): boolean {
  const auth = req.auth;
  return !!auth && auth.kind === 'api-token' && !!auth.missionId;
}

/**
 * Every route a conversion mission's token reaches. Closed by default: a route
 * added to the daemon later stays refused to this token until it is listed here.
 * Each line says which tool of `learn-browser-recording` calls it.
 */
const CONVERSION_ROUTES: readonly { method: string; path: RegExp }[] = [
  // browser_recording_get: the route answers this mission's recording only.
  { method: 'GET', path: /^\/api\/native-browser\/recordings\/[^/]+$/ },
  // skill_list, skill_get.
  { method: 'GET', path: /^\/api\/skills$/ },
  { method: 'GET', path: /^\/api\/skills\/[^/]+$/ },
  // skill_put: one new browser-* skill (`skillWriteRefusal`, #466).
  { method: 'POST', path: /^\/api\/skills$/ },
  // The timon-browser tools of the dry run: actions bounded by `conversionBrowserRefusal`.
  { method: 'POST', path: /^\/api\/native-browser\/mission\/command$/ },
  // `question`, and the harness's own Allow/Deny cards: a person answers both (`conversionFormRefusal`).
  { method: 'POST', path: /^\/api\/permissions\/request$/ },
  { method: 'GET', path: /^\/api\/health$/ },
];

/** Whether `method path` is on the conversion mission's list. Case-sensitive on purpose: a spelling the list does not know is refused. */
export function conversionRouteAllowed(method: string, path: string): boolean {
  return CONVERSION_ROUTES.some((route) => route.method === method && route.path.test(path));
}

export const CONVERSION_SCOPE = 'this mission converts a browser recording and may only read that recording, '
  + 'list and read skills, create its one browser-* skill, read the Timon docs, open the pages the recording holds '
  + 'and read them in the built-in browser, and ask you questions';

const CONVERSION_HINT = 'Finish the conversion with those tools; anything else is for the user or for another mission.';

/**
 * 403 for a conversion mission's request outside `CONVERSION_ROUTES`. Returns
 * true when the response has been sent. Called by the auth middleware for every
 * mission token, before any route sees the request.
 */
export function rejectConversionRoute(req: Request, res: Response): boolean {
  if (!conversionMissionOf(req)) return false;
  if (conversionRouteAllowed(req.method, req.path)) return false;
  return forbidden(req, res, { kind: 'scope', reason: CONVERSION_SCOPE, hint: CONVERSION_HINT });
}

/** What `navigate_page`, `list_pages`, `select_page` and `take_snapshot` send (`bin/browser-mcp.mjs`), and `start`, sent before each. */
const CONVERSION_BROWSER_ACTIONS = new Set(['start', 'status', 'navigate', 'back', 'forward', 'reload', 'activateTab', 'evaluate']);

/**
 * Refusal reason for a browser command of the conversion mission, or null.
 * It reads pages for its dry run and changes nothing in them: no click, no
 * typing, no saved login, no new tab, no script but the snapshot's. It opens
 * only the URLs the recording holds, exactly (`recordedUrls`): a URL it built —
 * another site, or the recorded site's own origin with a path or a query of its
 * choosing, which the site's owner reads in their logs — would carry what the
 * mission read out (TODO #471).
 */
export function conversionBrowserRefusal(conversion: ConversionMission, body: unknown): string | null {
  const command = (body && typeof body === 'object' ? body : {}) as { action?: unknown; expression?: unknown; url?: unknown };
  if (!conversion.recording) return 'the browser recording this mission converts was deleted: it drives no browser';
  const action = typeof command.action === 'string' ? command.action : '';
  if (!CONVERSION_BROWSER_ACTIONS.has(action)) {
    return 'the conversion mission of a browser recording only opens and reads pages for its dry run '
      + '(navigate_page, take_snapshot, list_pages, select_page)';
  }
  if (action === 'evaluate' && command.expression !== BROWSER_SNAPSHOT_SCRIPT) {
    return 'the conversion mission of a browser recording runs no script in a page; take_snapshot reads it';
  }
  if (action === 'navigate') {
    const target = recordedUrlKey(command.url);
    if (!target || !recordedUrls(conversion.recording).has(target)) {
      return 'the conversion mission of a browser recording opens only the URLs its recording holds, exactly: '
        + 'the start page and the url of a navigate step';
    }
  }
  return null;
}

/**
 * The command the browser receives once `conversionBrowserRefusal` let it through: a `navigate`
 * carries its URL in the form the guard compared, never the raw string. Two parsers may read the
 * same raw URL differently (a tab or backslash, a dot segment); what was allowed is what opens.
 */
export function conversionBrowserCommand<T>(body: T): T {
  if (!body || typeof body !== 'object') return body;
  const command = body as { action?: unknown; url?: unknown };
  if (command.action !== 'navigate') return body;
  const url = recordedUrlKey(command.url);
  return url ? { ...body, url } : body;
}

/**
 * The URLs a conversion may open: the recording's `startUrl` and the `url` of its `navigate`
 * steps, as stored (masked at capture and again on write), minus any that carries a `{SECRET:…}`
 * placeholder (a sign-in callback the skill must never open). Read from the steps at each
 * navigation: the review may have edited them, and they are gone once the mission ended — then
 * only the start page is left, and nothing at all if they cannot be read.
 */
function recordedUrls(recording: BrowserRecordingMetadata): ReadonlySet<string> {
  let steps: readonly RecordedStep[] = [];
  try { steps = readBrowserRecordingSteps(recording) ?? []; } catch { return new Set(); }
  const urls = [recording.startUrl, ...steps.filter((step) => step.type === 'navigate').map((step) => step.url)];
  return new Set(urls.flatMap((url) => {
    const key = recordedUrlKey(url);
    return key ? [key] : [];
  }));
}

const SECRET_PLACEHOLDER = /\{SECRET:|%7BSECRET:/i;

/**
 * The form two URLs are compared in: the parser's own serialisation (case of the scheme and host,
 * default port, a bare host's `/`), which changes no byte the site receives. HTTP(S) only.
 */
function recordedUrlKey(url: unknown): string | null {
  if (typeof url !== 'string' || !url || SECRET_PLACEHOLDER.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return SECRET_PLACEHOLDER.test(parsed.href) ? null : parsed.href;
  } catch {
    return null;
  }
}

/**
 * Refusal reason for a card the conversion mission asks for, or null. A
 * `question` form (`input.questions`) and the harness's Allow/Deny cards are
 * answered by a person; a typed form (`input.form`: the Kanban planner, a
 * plugin's) hands back commands or settings the mission has no use for.
 */
export function conversionFormRefusal(input: unknown): string | null {
  if (input && typeof input === 'object' && 'form' in input) {
    return 'the conversion mission of a browser recording asks questions only; it opens no other form';
  }
  return null;
}

/**
 * The MCP servers of Timon a conversion mission is handed (`spawnTurn`, `provider-mcp.ts`): their
 * every call goes through the daemon, where `CONVERSION_ROUTES` bounds it. Not `grepai`, which
 * serves file contents and is not handed to it. Compared as a harness spells them (codex rewrites
 * `-` into `_`).
 */
const CONVERSION_MCP_SERVERS = new Set(['timon', ASK_MCP_SERVER, LEGACY_ASK_MCP_SERVER, CHROME_DEVTOOLS_MCP_KEY].map(mcpServerKey));

function mcpServerKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** The server of a harness's MCP tool name (`mcp__<server>__<tool>`), or null for a built-in tool. */
function mcpServerOf(toolName: string): string | null {
  const match = /^mcp__(.+?)__./.exec(toolName);
  return match ? match[1]! : null;
}

/**
 * Refusal reason for an Allow/Deny card a conversion mission's CLI asks for, or null. Closed by
 * default: a form (`question`) or a tool of one of Timon's own MCP servers (its route is bounded by
 * `CONVERSION_ROUTES`) reaches a person. Everything else is denied before any card exists: a shell,
 * a write, an edit, a fetch, a file read (`Read`, `Glob`, `Grep`, `LS`: a secret read off the disk
 * would end up in the skill it writes, TODO #471), and the tool of any other MCP server — an
 * account connector (a notes connector, Gmail…) or a user's server never goes through the daemon, so the
 * route list bounds nothing there. The launch already removed all of those (`readOnlyTools`); this
 * is the second line, for a CLI that would offer one anyway.
 */
export function conversionToolCardRefusal(toolName: string): string | null {
  if (isFormCardTool(toolName)) return null;
  const server = mcpServerOf(toolName);
  if (server !== null) {
    if (CONVERSION_MCP_SERVERS.has(mcpServerKey(server))) return null;
    return `the conversion mission of a browser recording calls Timon's own tools only: ${toolName} is denied`;
  }
  return `the conversion mission of a browser recording runs no shell and reads or writes no file: ${toolName} is denied`;
}
