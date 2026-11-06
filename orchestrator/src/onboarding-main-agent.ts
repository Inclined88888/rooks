/**
 * Onboarding step 3 — naming the orchestrator you are about to work with.
 *
 * A fresh install seeds `_main`, and that is what the cockpit showed as the
 * user's main agent. A technical placeholder is a poor first impression, and
 * nothing in the product ever offered to change it during setup.
 *
 * The step writes the identity and a default workspace:
 *   - the NAME, which is the agent's identity everywhere in Timon, so this is
 *     a real `renameAgent` (directory + DB references + roles.json) and the
 *     new name is recorded for the orchestrator fallbacks (`main-agent.ts`);
 *   - the AVATAR, an uploads URL served by this daemon, stored in `icon_url`;
 *   - the OBJECTIVE and the free description, both into `SOUL.md`, which
 *     `buildEffectivePrompt` injects. `system-prompt.md` is NOT touched: it
 *     carries the technical instructions the orchestrator needs and a
 *     personality must never overwrite them.
 *
 * Everything here is optional except the name, and everything stays editable
 * afterwards in the agent form — the screen says so.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CONFIG_FILE, config, expandTilde } from './config/load.js';
import { z } from 'zod';
import { getAgent, loadSoul, patchAgentConfig, renameAgent } from './agent.js';
import { dbApi } from './db.js';
import { MAIN_AGENT_KEY, mainAgentName, setMainAgentName } from './main-agent.js';
import { readTeamState, teamOnboardingPending, writeTeamState } from './onboarding-team-state.js';
import { WORKSPACE_DIR, agentDir } from './paths.js';
import { isServedIconUrl } from './uploads.js';

/** Marks step 3 as answered. Separate from the team state: the two steps fail
 *  and resume independently, and a team retry must not reopen this one. */
export const MAIN_AGENT_STEP_KEY = 'onboarding.mainAgent.v1';

/**
 * Marks the name of step 3 as given (`applyMainAgentName`), so the wizard resumes on the chat
 * instead of asking it again. Explicit, never inferred from the agent's name: the seat may be held
 * by any name (a role holder found by `mainAgentName`), and `_main` is only the seed's default.
 */
export const MAIN_AGENT_NAMED_KEY = 'onboarding.mainAgent.named';

/**
 * What the person answered to "Want a 2-minute tour?" at the end of the setup
 * conversation (`setup_finish {tour}`): `'0'` when they chose to get to work. Read
 * by the wizard, which arms the guided tour unless it says no.
 */
export const MAIN_AGENT_TOUR_KEY = 'onboarding.mainAgent.tour';

export class MainAgentSetupError extends Error {}

/** The only origins an avatar may come from — both are served by this daemon.
 *  Anything else would let onboarding pin a remote URL into the agent config. */
const AVATAR_PREFIXES = ['/api/uploads/projects/', '/api/uploads/avatars/'];

export const MainAgentSchema = z.object({
  name: z.string().min(1).max(48),
  objective: z.string().max(2_000).optional(),
  soul: z.string().max(20_000).optional(),
  avatarUrl: z.string().max(300).nullable().optional(),
}).strict();

export type MainAgentInput = z.infer<typeof MainAgentSchema>;

/**
 * A display name typed by a human → a valid agent name.
 *
 * Agent names are a filesystem identity (`^[A-Za-z0-9._-]+$`), so "Nova the
 * assistant" cannot be one. We convert rather than refuse: the screen shows
 * the result, and refusing a space would be a rule the user has no way to
 * guess.
 */
export function toAgentName(raw: string): string {
  return raw
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
}

export function mainAgentOnboardingPending(): boolean {
  return teamOnboardingPending() && dbApi.getAllSettings()[MAIN_AGENT_STEP_KEY] !== 'complete';
}

/**
 * The name step was answered. Before the marker existed, naming already recorded the seat
 * (`MAIN_AGENT_KEY`, which seeding never writes): an install updated mid-wizard keeps its name.
 */
function mainAgentNamed(): boolean {
  const settings = dbApi.getAllSettings();
  return settings[MAIN_AGENT_NAMED_KEY] === '1' || Boolean(settings[MAIN_AGENT_KEY]);
}

/** What the screen prefills with: the orchestrator as it stands today. */
export function mainAgentStatus() {
  const name = mainAgentName();
  const agent = name ? getAgent(name) : null;
  return {
    status: mainAgentOnboardingPending() ? 'pending' : 'complete',
    available: agent !== null,
    name: agent?.name ?? null,
    /** The name step is behind: the wizard resumes on the chat with `name`. */
    named: agent !== null && mainAgentNamed(),
    avatarUrl: agent?.icon_url ?? null,
    soul: name ? loadSoul(name) : '',
    /** The guided tour follows the step, unless the person declined it in the conversation. */
    tour: dbApi.getAllSettings()[MAIN_AGENT_TOUR_KEY] !== '0',
  };
}

/**
 * The cockpit card the product opens on, seeded for the whole machine.
 *
 * `agent-chat` is an UNHASHED layout scope, so a row written under `owner=''`
 * is the template every account reads until it writes its own
 * (`dbApi.uiLayoutGet`). That is what lets a build ship an arranged cockpit:
 * the placement itself lives in the client's starters, keyed by
 * `plugin:@timon/agent-chat:main`, but only the daemon knows WHICH agent that
 * card shows — the name is chosen here, one screen earlier.
 *
 * Written at the end of step 3, and only there: an account that has since
 * renamed, moved or deleted the card owns a row of its own, and this one is
 * never consulted again for it.
 */
export const MAIN_AGENT_CARD_ID = 'main';

export function seedMainAgentCard(agent: string, title: string, avatar: string | null): void {
  dbApi.uiLayoutSet('', 'agent-chat', JSON.stringify({
    instances: [{ id: MAIN_AGENT_CARD_ID, agent, title, avatar: avatar ?? '', zone: 'centre', subAgents: [] }],
  }));
}

/** `SOUL.md`, assembled from the two things the screen asks for. */
function composeSoul(input: MainAgentInput, displayName: string): string {
  const parts = [`You are ${displayName}, the user's main agent in Timon.`];
  const objective = input.objective?.trim();
  const soul = input.soul?.trim();
  if (objective) parts.push(`## Main objective\n\n${objective}`);
  if (soul) parts.push(soul);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Phase 1 — the name: rename the seeded agent, record it, give it its
 * workspace and its role. Nothing runs yet when the form (or the conversation's
 * name field) calls this, so the rename cannot meet a live mission (409).
 * Returns the agent's name after the rename.
 */
export function applyMainAgentName(rawName: string): string {
  const current = mainAgentName();
  if (!current) throw new MainAgentSetupError('main_agent_unavailable');

  const display = rawName.trim();
  const target = toAgentName(display);
  if (!target) throw new MainAgentSetupError('invalid_name');
  if (target !== current && existsSync(agentDir(target))) throw new MainAgentSetupError('name_taken');

  // Read the wizard's saved config, which may postdate this daemon's boot.
  let cwd = getAgent(current)?.cwd;
  if (!cwd) {
    // A config file left half-written or edited by hand is a workspace this
    // step cannot find: the wizard says so, rather than a 500.
    let saved: { workspacesRoot?: unknown } = {};
    try {
      if (existsSync(CONFIG_FILE)) saved = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as typeof saved;
    } catch { throw new MainAgentSetupError('workspace_unavailable'); }
    if (!saved || typeof saved !== 'object') throw new MainAgentSetupError('workspace_unavailable');
    const savedRoot = typeof saved.workspacesRoot === 'string' ? saved.workspacesRoot : '';
    const rawRoot = savedRoot || config().workspacesRoot;
    const root = rawRoot ? expandTilde(rawRoot) : WORKSPACE_DIR;
    if (!isAbsolute(root)) throw new MainAgentSetupError('workspace_unavailable');
    try {
      mkdirSync(root, { recursive: true });
      cwd = realpathSync(root);
    } catch { throw new MainAgentSetupError('workspace_unavailable'); }
  }

  if (target !== current) {
    const renamed = renameAgent(current, target);
    if (!renamed.ok) throw new MainAgentSetupError('rename_failed');
  }
  // A prompt seeded before the seed stopped naming the agent still opens on
  // "You are _main": the renamed agent then introduced itself as `_main`.
  const promptFile = join(agentDir(target), 'system-prompt.md');
  if (target !== current && existsSync(promptFile)) {
    const prompt = readFileSync(promptFile, 'utf8');
    const seeded = `You are ${current}, the orchestrator`;
    if (prompt.startsWith(seeded)) writeFileSync(promptFile, `You are ${display}, the orchestrator${prompt.slice(seeded.length)}`);
  }
  // Recorded even when nothing moved: the fallbacks in `main-agent.ts` then
  // hold a name that survives a later rename made from the agent form.
  setMainAgentName(target);
  patchAgentConfig(target, { cwd, role: 'orchestrator' });
  dbApi.setSetting(MAIN_AGENT_NAMED_KEY, '1');
  return target;
}

/** Only the two origins an avatar may come from — both are served by this daemon.
 *  The full shape too: a prefix alone would let `/api/uploads/avatars/../x` be
 *  stored, then read back as no picture (`servedIconUrl`). */
export function assertAvatarUrl(url: string): void {
  if (!AVATAR_PREFIXES.some((prefix) => url.startsWith(prefix)) || !isServedIconUrl(url)) throw new MainAgentSetupError('invalid_avatar');
}

/** Phase 2a — the picture, live: the same field the form writes. */
export function setMainAgentAvatar(url: string): void {
  assertAvatarUrl(url);
  const name = mainAgentName();
  if (!name) throw new MainAgentSetupError('main_agent_unavailable');
  patchAgentConfig(name, { icon_url: url });
}

/** Phase 2b — the character, live. `SOUL.md` only: `system-prompt.md` carries the
 *  technical instructions and a personality must never overwrite them. */
export function setMainAgentSoul(input: { soul?: string; objective?: string }): void {
  const name = mainAgentName();
  if (!name) throw new MainAgentSetupError('main_agent_unavailable');
  const text = composeSoul({ name, ...input }, name);
  writeFileSync(join(agentDir(name), 'SOUL.md'), text);
}

/** Phase 3 — the end: the cockpit card, and the step answered. Set ONCE, here:
 *  the gate moves the user off the screen the moment the key says `complete`. */
/**
 * The team step is gone from the wizard: answering step 3 answers it too, as
 * "start from scratch" — the main agent alone. A team already being applied
 * (an install that chose before this change) is left to finish its own way.
 */
function closeTeamStep(): void {
  if (readTeamState()?.status === 'pending') writeTeamState({ status: 'complete', preset: 'scratch', agents: [] });
}

export function finishMainAgent(opts: { tour?: boolean } = {}) {
  const name = mainAgentName();
  if (!name) throw new MainAgentSetupError('main_agent_unavailable');
  const agent = getAgent(name);
  seedMainAgentCard(name, name, agent?.icon_url ?? null);
  dbApi.setSetting(MAIN_AGENT_TOUR_KEY, opts.tour === false ? '0' : '1');
  dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
  closeTeamStep();
  return mainAgentStatus();
}

/** The form: all three phases at once, as before. */
export function applyMainAgent(input: MainAgentInput) {
  if (input.avatarUrl) assertAvatarUrl(input.avatarUrl);
  const display = input.name.trim();
  const target = applyMainAgentName(display);
  if (input.avatarUrl) patchAgentConfig(target, { icon_url: input.avatarUrl });
  writeFileSync(join(agentDir(target), 'SOUL.md'), composeSoul(input, display));
  seedMainAgentCard(target, display, input.avatarUrl ?? null);
  dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
  closeTeamStep();
  return mainAgentStatus();
}

/** Skipping is a legitimate answer: the seeded `_main` keeps working, and the
 *  step must not be able to trap someone on a screen they do not care about. */
export function skipMainAgent() {
  // The cockpit still opens on a chat: skipping named nothing, so the card
  // shows the orchestrator as it stands. A card on `_main` beats an empty
  // centre, and renaming the agent later is a rename the card follows.
  const current = mainAgentName();
  if (current) seedMainAgentCard(current, '', getAgent(current)?.icon_url ?? null);
  dbApi.setSetting(MAIN_AGENT_STEP_KEY, 'complete');
  closeTeamStep();
  return mainAgentStatus();
}
