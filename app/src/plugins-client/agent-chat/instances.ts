'use client';

/**
 * The instances of the agent-chat widget: which agent each card shows, and the
 * sub-agents of its avatar row.
 *
 * A widget is normally one card per plugin. This one is a *template*: the same
 * code renders the main agent, a helper agent, or any agent yet to be created, and the
 * user is expected to want several at once. What distinguishes two cards is
 * therefore data, not code — hence an instance list, and one registration per
 * instance keyed by its id (`plugin:@rooks/agent-chat:<id>`, the couple the
 * host persists a placement under).
 *
 * Persistence goes to the daemon under its own layout scope. `ui_layout` is an
 * opaque per-scope JSON store — the front owns the shape — so an instance list
 * follows the user across browsers and machines and travels with
 * `rooks export`, exactly like the placement it is meaningless without.
 */

import { COCKPIT_CENTRE } from '@/components/cockpit/cockpit-zones';
import { MAIN_AGENT_CARD_ID } from '@/lib/main-agent-card';
import { mainAgentOf, type MainAgentCandidate } from '@/lib/main-agent';
import { loadLayout, saveLayout } from '@/lib/ui-layout-store';

/** Layout scope holding the instance list. Must match `^[a-z0-9][a-z0-9._-]*$`
 *  (the daemon's scope grammar), so it can't be the `@rooks/…` module id. */
export const AGENT_CHAT_SCOPE = 'agent-chat';

/** An agent of the avatar row, in the order the config gives. Its picture and
 *  its name come from the agent itself, like everywhere else in the product,
 *  unless the card was customised (right-click → Customize agent): then the
 *  nickname and the photo below win, on this card only. */
export type SubAgent = {
  /** Agent name as `~/.rooks/agents/` spells it — casing included. */
  agent: string;
  /** Nickname on this card. Absent means the agent's own name. */
  label?: string;
  /** Photo (image URL) or emoji on this card. Absent means the agent's own. */
  avatar?: string;
};

export type AgentChatInstance = {
  /** Instance identity: the registration key, and the placement id. Stable for
   *  the life of the card, never derived from the agent (renaming the target
   *  must not send the card back to its default rail). */
  id: string;
  /** Agent shown when no sub-agent is selected. */
  agent: string;
  /** Card title. Empty means "use the agent name". */
  title: string;
  /** Avatar image URL. Empty means "fall back to the agent's own icon". */
  avatar: string;
  /** Zone of first placement, empty for the host's default. Only the seeded
   *  instance sets it, to land in the cockpit centre rather than a rail; once
   *  the user has dragged the card, its placement wins over this. */
  zone: string;
  subAgents: SubAgent[];
};

/**
 * The instance a fresh install starts with: the main agent, in the cockpit
 * centre, which is the first screen of the product.
 *
 * A shipped build ships no named agent: onboarding creates the main agent and
 * lets its owner name it, so the seed cannot know that name at build time. The
 * daemon therefore writes this row itself at the end of step 3
 * (`orchestrator/src/onboarding-main-agent.ts`), with the chosen name, title
 * and avatar; what follows is only the recourse for an install whose row was
 * never written, and it resolves the agent by ROLE, never by a literal.
 *
 * It stays config and not code: renaming the card, pointing it at another
 * agent or deleting it writes the list and the seed never comes back.
 */
export function grainePourAgent(agent: string): AgentChatInstance {
  return { id: MAIN_AGENT_CARD_ID, agent, title: '', avatar: '', zone: COCKPIT_CENTRE, subAgents: [] };
}

/** Summary of an installed agent, as `/api/agents` gives it. */
export type AgentInstalle = MainAgentCandidate;

/** The main agent: flagged by the daemon, found by role on an older one
 *  (`@/lib/main-agent`). */
export function agentPrincipal(agents: readonly AgentInstalle[]): string | null {
  return mainAgentOf(agents);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normaliserSousAgents(raw: unknown): SubAgent[] {
  if (!Array.isArray(raw)) return [];
  const sortie: SubAgent[] = [];
  const vus = new Set<string>();
  for (const brut of raw) {
    if (typeof brut !== 'object' || brut === null) continue;
    const item = brut as Record<string, unknown>;
    const agent = str(item.agent);
    // Two buttons on the same agent would toggle the same thread: the second
    // is a config mistake, not a mode.
    if (!agent || vus.has(agent.toLowerCase())) continue;
    vus.add(agent.toLowerCase());
    const label = str(item.label);
    const avatar = str(item.avatar);
    sortie.push({ agent, ...(label ? { label } : {}), ...(avatar ? { avatar } : {}) });
  }
  return sortie;
}

/**
 * Reads back what the daemon stored. The value is opaque JSON written by an
 * older version of this file, or by a hand-edited export: anything that isn't
 * an instance is dropped rather than crashing the cockpit.
 */
export function normaliserInstances(raw: unknown): AgentChatInstance[] {
  const liste = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null
      ? (raw as { instances?: unknown }).instances
      : null;
  if (!Array.isArray(liste)) return [];

  const sortie: AgentChatInstance[] = [];
  const vus = new Set<string>();
  for (const brut of liste) {
    if (typeof brut !== 'object' || brut === null) continue;
    const item = brut as Record<string, unknown>;
    const id = str(item.id);
    const agent = str(item.agent);
    // An instance without an id has no placement and no registration key; one
    // without an agent has no thread to show. Both are unrenderable.
    if (!id || !agent || vus.has(id)) continue;
    vus.add(id);
    sortie.push({
      id,
      agent,
      title: str(item.title),
      avatar: str(item.avatar),
      zone: str(item.zone),
      subAgents: normaliserSousAgents(item.subAgents),
    });
  }
  return sortie;
}

/** Card title: what the config says, else the agent it shows. */
export function titreInstance(instance: AgentChatInstance): string {
  return instance.title || instance.agent;
}

/** One avatar of the row on top of the card: the instance's own agent, then
 *  its sub-agents. Only the card's own agent can carry an `avatar` — the image
 *  the daemon wrote on the card at onboarding. */
export type ModeAgent = { value: string; label: string; avatar?: string };

/**
 * The modes a card offers, in config order.
 *
 * An instance on one agent with others under it offers one shortcut per
 * agent, whichever agents they are, and any number of them.
 */
export function modesDeLInstance(instance: AgentChatInstance): ModeAgent[] {
  const propre: ModeAgent = { value: instance.agent, label: titreInstance(instance) };
  if (instance.avatar) propre.avatar = instance.avatar;
  return [
    propre,
    ...instance.subAgents.map((s): ModeAgent => ({
      value: s.agent,
      label: s.label || s.agent,
      ...(s.avatar ? { avatar: s.avatar } : {}),
    })),
  ];
}

/** Nickname and photo of one agent of the card, as the Customize dialog edits
 *  them. Empty strings mean "back to the agent's own". */
export type Personnalisation = { label: string; avatar: string };

/** What the card currently overrides for `agent`. */
export function personnalisationDe(instance: AgentChatInstance, agent: string): Personnalisation {
  if (agent === instance.agent) return { label: instance.title, avatar: instance.avatar };
  const sous = instance.subAgents.find((s) => s.agent === agent);
  return { label: sous?.label ?? '', avatar: sous?.avatar ?? '' };
}

/** The instance with `agent` customised. The card's own agent keeps its
 *  nickname in `title` and its photo in `avatar`, as it always did. */
export function personnaliserAgent(
  instance: AgentChatInstance,
  agent: string,
  { label, avatar }: Personnalisation,
): AgentChatInstance {
  const propre = { label: label.trim(), avatar: avatar.trim() };
  if (agent === instance.agent) return { ...instance, title: propre.label, avatar: propre.avatar };
  return {
    ...instance,
    subAgents: instance.subAgents.map((s) => {
      if (s.agent !== agent) return s;
      return {
        agent: s.agent,
        ...(propre.label ? { label: propre.label } : {}),
        ...(propre.avatar ? { avatar: propre.avatar } : {}),
      };
    }),
  };
}

/**
 * The instance without `agent`, or `null` when it was the last one — the card
 * then has nobody left to show and goes away. Removing the card's own agent
 * promotes the first sub-agent, which brings its nickname and photo with it.
 */
export function retirerAgent(instance: AgentChatInstance, agent: string): AgentChatInstance | null {
  if (agent !== instance.agent) {
    return { ...instance, subAgents: instance.subAgents.filter((s) => s.agent !== agent) };
  }
  const [premier, ...reste] = instance.subAgents;
  if (!premier) return null;
  return { ...instance, agent: premier.agent, title: premier.label ?? '', avatar: premier.avatar ?? '', subAgents: reste };
}

/**
 * The agent actually shown. A selection nobody offers any more — the config was
 * edited, an export was restored — falls back to the instance's own agent
 * rather than leaving the card on a thread it can no longer switch away from.
 */
export function agentAffiche(instance: AgentChatInstance, selection: string): string {
  return modesDeLInstance(instance).some((m) => m.value === selection) ? selection : instance.agent;
}

/** Fresh id. `randomUUID` is absent from insecure origins and old browsers,
 *  where a timestamped counter is enough: the id only has to be unique inside
 *  one instance list. */
let compteur = 0;
export function nouvelIdInstance(): string {
  const crypto = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  compteur += 1;
  return `i${Date.now().toString(36)}${compteur.toString(36)}`;
}

// ── Store ────────────────────────────────────────────────────────────────

let instances: AgentChatInstance[] = [];
let chargees = false;
const abonnes = new Set<() => void>();

function publier(): void {
  for (const abonne of abonnes) abonne();
}

export function instancesActuelles(): readonly AgentChatInstance[] {
  return instances;
}

export function abonnerInstances(listener: () => void): () => void {
  abonnes.add(listener);
  return () => abonnes.delete(listener);
}

/**
 * Loads the list once per page. A daemon that did not answer leaves the list
 * empty and `chargees` false: the next mount tries again, and nothing is
 * written meanwhile — saving over a placement we failed to read is how a
 * config disappears.
 */
export async function chargerInstances(): Promise<void> {
  if (chargees) return;
  const { raw, ok } = await loadLayout({ scope: AGENT_CHAT_SCOPE });
  if (!ok) return;
  // `raw === null` is the only "never written" signal: an emptied list is
  // stored as `{ instances: [] }`, so deleting the seeded card keeps it
  // deleted instead of resurrecting it at the next reload.
  const agents = raw === null ? await agentsInstalles() : undefined;
  // Nothing written AND no answer about the agents: we do not know who the
  // card would show. Leaving `chargees` false makes the next mount ask again,
  // rather than fixing an empty cockpit until the page is reloaded.
  if (raw === null && agents === undefined) return;
  chargees = true;
  instances = instancesAuChargement(raw, agents);
  publier();
}

/**
 * The installed agents, or `undefined` when we could not ask (step 5.9.5).
 *
 * Only consulted to decide whether the SEED has anything to point at. A
 * failure is `undefined`, not an empty list: "we do not know" must not read as
 * "there is no agent" and silently swallow the card on a slow daemon.
 */
async function agentsInstalles(): Promise<readonly AgentInstalle[] | undefined> {
  try {
    const r = await fetch('/api/ui/agents', { cache: 'no-store' });
    if (!r.ok) return undefined;
    const j = (await r.json()) as { agents?: AgentInstalle[] };
    return j.agents ?? [];
  } catch {
    return undefined;
  }
}

/**
 * What the store holds after a successful load. `null` means never written
 * (fresh install → the seeded card). An emptied list is `{ instances: [] }`,
 * which must not resurrect the seed — that is how deleting the main agent's
 * card proves it was only an instance, not a product tile.
 *
 * `agents` is the installed list, and the seed is built FROM it: an install
 * with no agent to show gets no card rather than one that polls
 * `/api/ui/agents/<nobody>/git` every 30 seconds for a 404. A surface whose
 * subject does not exist must efface itself, not interrogate the void.
 *
 * The rule applies to the SEED ONLY. A card the user configured keeps its
 * thread even if its agent was deleted since — that is a deliberate choice
 * (see `use-agents.ts`), and nobody chose the seed.
 */
export function instancesAuChargement(
  raw: unknown,
  agents?: readonly AgentInstalle[],
): AgentChatInstance[] {
  if (raw !== null) return normaliserInstances(raw);
  const principal = agentPrincipal(agents ?? []);
  return principal ? [grainePourAgent(principal)] : [];
}

async function ecrire(suivantes: AgentChatInstance[]): Promise<boolean> {
  instances = suivantes;
  // A write that lands before the load answered wins: reloading afterwards
  // would put back the list the user just changed.
  chargees = true;
  publier();
  return saveLayout({ instances: suivantes }, { scope: AGENT_CHAT_SCOPE });
}

/** Adds the instance, or replaces the one carrying the same id. */
export function enregistrerInstance(instance: AgentChatInstance): Promise<boolean> {
  const index = instances.findIndex((i) => i.id === instance.id);
  const suivantes = [...instances];
  if (index === -1) suivantes.push(instance);
  else suivantes[index] = instance;
  return ecrire(suivantes);
}

export function supprimerInstance(id: string): Promise<boolean> {
  return ecrire(instances.filter((i) => i.id !== id));
}

/** Test seam: the store is module state, and one test's list must not leak
 *  into the next. */
export function reinitialiserInstancesPourTests(): void {
  instances = [];
  chargees = false;
  abonnes.clear();
}
