/**
 * The main agent's welcome, as a conversation: right after the onboarding the
 * person lands on the TIMs page (`/bots`) and their main agent speaks first.
 *
 * The name, the look and the card are settled BEFORE the chat, in the
 * onboarding (`applyMainAgentName`), so the rename has nothing to meet. The
 * chat holds the rest, live: the character (`setup_set_soul`), the choice of
 * what comes next, and the end (`setup_finish`, which marks the step answered
 * — set ONCE, there). `/setup/agent` hosts the same conversation, as the
 * repair screen.
 *
 * Authority is narrow on purpose. These are not `agents:manage` tools: they
 * work for ONE mission — the main agent's, started by the account that runs the
 * setup — and only while the step is pending. After `setup_finish` they refuse.
 */
import { randomUUID } from 'node:crypto';
import { availableSeededLlmDefaults, isRunning, killAgent, loadConfig, patchAgentConfig, spawnAgent, type KillOrigin } from './agent.js';
import { isAuthFailureEvent } from './backend-breaker.js';
import { defaultBackendName } from './backends/index.js';
import { bus, type BusEvent } from './bus.js';
import { dbApi, type MissionRow } from './db.js';
import { composeChatTurn } from './chat-attachments.js';
import { deliverLate } from './late-delivery.js';
import { mainAgentName } from './main-agent.js';
import { mainAgentOnboardingPending, MainAgentSetupError } from './onboarding-main-agent.js';
import { expandSlashCommand } from './slash.js';

export const SETUP_CHAT_SKILL = 'rooks-main-agent-setup';
/** `source.channel` of the setup conversation: the client hides its bootstrap turn by origin. */
export const SETUP_CHANNEL = 'setup';
const AVATAR_REQUEST_KEY = 'onboarding.avatarRequest.v1';
/** Persisted event the chat draws as the upload card. */
export const SETUP_AVATAR_REQUEST_EVENT = 'setup_avatar_request';
/** …and its answer, persisted too: a reload shows the card as it was left. */
export const SETUP_AVATAR_ANSWERED_EVENT = 'setup_avatar_answered';

/** Persists the event AND puts it on the open chat's stream. */
function publish(missionId: string, type: string, payload: object): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  bus.publish({ kind: 'event', missionId, type, timestamp: row.timestamp, payload });
}

/**
 * The model a fresh install's main agent starts on, by the backend it runs on.
 * Not a promise about quality: a sensible default so the first conversation is
 * neither the cheapest nor the slowest. Anything not listed keeps its seed.
 */
export const SETUP_DEFAULT_MODELS: ReadonlyArray<{ backend: RegExp; model: string }> = [
  { backend: /^claude/i, model: 'sonnet' },
  { backend: /^codex/i, model: 'gpt-5.6-sol' },
];

export function setupDefaultModel(backend: string | null | undefined): string | null {
  if (!backend) return null;
  return SETUP_DEFAULT_MODELS.find((m) => m.backend.test(backend))?.model ?? null;
}

/** The interface language, named in English for the brief (`fr` → `French`); the tag itself when unknown. */
export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch { return locale; }
}

/**
 * The first turn's brief: what the agent knows of the person and of itself when
 * it speaks first. Plain facts, read from the account and the agent's config —
 * the skill says what to do with them. The folder is the one the agent works
 * in now, which the creation sheet may have changed: never the default to assume.
 */
export function setupBrief(input: {
  agent: string; userName: string | null; locale: string; cwd: string | null; directives: string | null;
}): string {
  const first = input.userName?.trim().split(/\s+/)[0] ?? '';
  const lines = [
    `Your name is "${input.agent}". Speak first.`,
    first ? `The user's first name is "${first}".` : 'The user did not give a first name: greet them without one.',
    `Speak ${languageName(input.locale)} (\`${input.locale}\`): they chose it on the first screen.`,
    input.cwd ? `Your working folder is \`${input.cwd}\`.` : 'You have no working folder yet.',
  ];
  const directives = input.directives?.trim();
  lines.push(directives
    ? `The card the user made for you (your directives, as saved):\n\n${directives}`
    : 'The card the user made for you holds no directives: they picked a look and a name only.');
  return lines.join('\n');
}

export type SetupChatRefusal = 'step_not_pending' | 'no_main_agent' | 'not_setup_account';

/** Is this mission the main agent's setup conversation, still open? */
export function setupChatMission(mission: MissionRow | undefined | null, ownerUserId?: string | null):
  { ok: true; agent: string } | { ok: false; reason: SetupChatRefusal } {
  if (!mainAgentOnboardingPending()) return { ok: false, reason: 'step_not_pending' };
  const agent = mainAgentName();
  if (!agent) return { ok: false, reason: 'no_main_agent' };
  if (!mission || mission.agent_name !== agent || mission.source_channel !== SETUP_CHANNEL) {
    return { ok: false, reason: 'not_setup_account' };
  }
  if (ownerUserId !== undefined && mission.owner_user_id !== ownerUserId) return { ok: false, reason: 'not_setup_account' };
  const owner = mission.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
  if (!owner?.is_superadmin) return { ok: false, reason: 'not_setup_account' };
  return { ok: true, agent };
}

/**
 * The setup conversation this account already has open with the main agent:
 * the newest one whose process still runs. A second tab, a reload that lost its
 * session storage, or the person coming back to the TIMs page later finds it
 * instead of meeting a second agent that greets them again. A conversation
 * whose process is gone is not one: starting over is what the page offers then.
 */
export function openSetupMission(
  ownerUserId: string,
  agent: string,
  live: (missionId: string) => boolean = isRunning,
): string | null {
  const open = dbApi.listRunningMissions()
    .filter((m) => m.source_channel === SETUP_CHANNEL && m.agent_name === agent && m.owner_user_id === ownerUserId && live(m.id))
    .sort((a, b) => b.started_at - a.started_at);
  return open[0]?.id ?? null;
}

/** One start at a time per account: the page and a second tab asking together get the same conversation. */
const starting = new Map<string, Promise<{ missionId: string; agent: string; resumed: boolean }>>();

/**
 * Opens the conversation, or hands back the one already open
 * (`openSetupMission`, `resumed: true`): gives the agent its default model,
 * then starts a mission whose first turn is the bundled skill. The skill is
 * expanded the way a typed `/command` is; the turn is marked by origin so the
 * chat can keep it out of the transcript — the user should meet an agent that
 * speaks first.
 */
export async function startSetupChat(
  input: { ownerUserId: string; locale: string },
  opts: { firstTurnMs?: number } = {},
): Promise<{ missionId: string; agent: string; resumed: boolean }> {
  if (!mainAgentOnboardingPending()) throw new MainAgentSetupError('step_not_pending');
  const agent = mainAgentName();
  if (!agent) throw new MainAgentSetupError('main_agent_unavailable');
  const open = openSetupMission(input.ownerUserId, agent);
  if (open) return { missionId: open, agent, resumed: true };
  const pending = starting.get(input.ownerUserId);
  if (pending) return await pending;
  const started = spawnSetupChat(agent, input, opts);
  starting.set(input.ownerUserId, started);
  try {
    return await started;
  } finally {
    starting.delete(input.ownerUserId);
  }
}

async function spawnSetupChat(
  agent: string,
  input: { ownerUserId: string; locale: string },
  opts: { firstTurnMs?: number },
): Promise<{ missionId: string; agent: string; resumed: boolean }> {

  // The agent's own backend first, then every other CLI found on this machine:
  // a person who has Codex but whose Claude is not logged in still meets an agent.
  const current = loadConfig(agent).backend ?? defaultBackendName();
  const others = availableSeededLlmDefaults().map((d) => d.backend).filter((b) => b !== current);
  let lastError: unknown = null;
  for (const [index, backend] of [current, ...others].entries()) {
    if (index > 0) patchAgentConfig(agent, { backend });
    const config = loadConfig(agent);
    const model = setupDefaultModel(config.backend);
    if (model && config.model !== model) patchAgentConfig(agent, { model });
    else if (index > 0 && !model) patchAgentConfig(agent, { model: undefined });

    // The card the person just filled in, read back from the agent's config: the
    // conversation starts from it instead of asking again. The name is given here
    // too, since the instructions it boots on may still carry the seeded `_main`.
    const owner = dbApi.getUserById(input.ownerUserId);
    const brief = setupBrief({
      agent, userName: owner?.name ?? null, locale: input.locale, cwd: config.cwd ?? null, directives: config.directives ?? null,
    });
    const slash = await expandSlashCommand(`/${SETUP_CHAT_SKILL} ${brief}`, { cwd: config.cwd });
    const turn = composeChatTurn(slash, []);
    const missionId = randomUUID();
    const first = watchFirstTurn(missionId, opts.firstTurnMs ?? FIRST_TURN_MS);
    try {
      await spawnAgent(agent, turn.text, { channel: SETUP_CHANNEL }, {
        missionId,
        presentation: turn.presentation,
        // Owner BEFORE the child starts: its API token is issued from this row.
        ownerUserId: input.ownerUserId,
      });
    } catch (error) {
      first.cancel();
      lastError = error;
      continue;
    }
    // Still thinking at the deadline is not a failure: the wizard keeps its loader up.
    if (await first.outcome !== 'failed') return { missionId, agent, resumed: false };
    console.warn(`[setup-chat] ${backend} failed its first turn, trying the next backend`);
    killAgent(missionId, { source: 'setup: first turn failed', detail: backend });
  }
  throw lastError instanceof Error ? lastError : new Error('no backend answered the setup conversation');
}

/**
 * Ends every setup conversation still running. Called when the step is skipped:
 * once it is answered, the `setup_*` tools refuse with 409, so a mission left
 * alive could only idle until the reaper — or keep talking to a wizard that has
 * already moved on. Every `setup` mission is one of these, whatever the agent's
 * name: an earlier attempt (a backend that failed, a restarted chat) counts too.
 */
export function stopSetupChat(origin: KillOrigin): string[] {
  const stopped: string[] = [];
  for (const mission of dbApi.listRunningMissions()) {
    if (mission.source_channel !== SETUP_CHANNEL) continue;
    if (killAgent(mission.id, origin) !== 'not_found') stopped.push(mission.id);
  }
  return stopped;
}

/** How long the first turn may take before the wizard stops waiting for its verdict. */
const FIRST_TURN_MS = 60_000;

export type FirstTurnOutcome = 'ok' | 'failed' | 'pending';

/**
 * Watches a mission until its first turn proves the backend works: a `result`
 * that is not an error. A login refused, an error result, a turn that failed
 * or a process that died first all say it does not. Subscribe BEFORE spawning.
 */
export function watchFirstTurn(missionId: string, timeoutMs: number): { outcome: Promise<FirstTurnOutcome>; cancel: () => void } {
  let settle: (o: FirstTurnOutcome) => void = () => {};
  const outcome = new Promise<FirstTurnOutcome>((resolve) => { settle = resolve; });
  const listener = (ev: BusEvent): void => {
    if (!('missionId' in ev) || ev.missionId !== missionId) return;
    if (ev.kind === 'event') {
      if (isAuthFailureEvent(ev.type, ev.payload)) done('failed');
      // A form card (the skill opens on a `question`) proves the model answered; the turn waits on the user.
      else if (ev.type === 'permission_request') done('ok');
      else if (ev.type === 'result') done((ev.payload as { is_error?: unknown } | null)?.is_error === true ? 'failed' : 'ok');
    } else if (ev.kind === 'mission_complete') done('failed');
    else if (ev.kind === 'turn_complete' && ev.outcome === 'failed') done('failed');
  };
  const timer = setTimeout(() => done('pending'), timeoutMs);
  function done(o: FirstTurnOutcome): void {
    clearTimeout(timer);
    bus.off('event', listener);
    settle(o);
  }
  bus.on('event', listener);
  return { outcome, cancel: () => done('pending') };
}

// ── the picture ─────────────────────────────────────────────────────────────

type AvatarRequest = { id: string; missionId: string; status: 'pending' | 'set' | 'skipped' };

function readRequest(): AvatarRequest | null {
  const raw = dbApi.getAllSettings()[AVATAR_REQUEST_KEY];
  if (!raw) return null;
  try { return JSON.parse(raw) as AvatarRequest; } catch { return null; }
}

/** The agent asks for a picture: a card appears in the conversation; the answer comes back as a message. */
export function requestAvatar(missionId: string): { id: string } {
  const existing = readRequest();
  if (existing && existing.missionId === missionId && existing.status === 'pending') return { id: existing.id };
  const id = randomUUID();
  dbApi.setSetting(AVATAR_REQUEST_KEY, JSON.stringify({ id, missionId, status: 'pending' } satisfies AvatarRequest));
  publish(missionId, SETUP_AVATAR_REQUEST_EVENT, { id });
  return { id };
}

/** The user's answer to the card: a picture, or "not now". Tells the agent. */
export function answerAvatarRequest(id: string, answer: { avatarUrl: string } | { skipped: true }): boolean {
  const request = readRequest();
  if (!request || request.id !== id || request.status !== 'pending') return false;
  const next: AvatarRequest = { ...request, status: 'skipped' in answer ? 'skipped' : 'set' };
  dbApi.setSetting(AVATAR_REQUEST_KEY, JSON.stringify(next));
  publish(request.missionId, SETUP_AVATAR_ANSWERED_EVENT, { id, status: next.status });
  deliverLate(
    request.missionId,
    'skipped' in answer
      ? '[setup] The user chose not to set a picture now. Carry on with the next question.'
      : '[setup] The user set your picture. It is on your profile now. Carry on with the next question.',
  );
  return true;
}
