/**
 * The arrangements the onboarding tours propose, one list per profile. An
 * agent composing a layout from scratch gets a different screen each time, and
 * sometimes one that does not apply; these are fixed, and tested: the daemon's
 * validators (`onboarding-recipes.test.ts`) and the browser's own params
 * parsers (`app/src/lib/onboarding-recipes.test.ts`) run every one of them.
 *
 * Each tour skill (`skills.ts`) prints its profile's list with `renderRecipes`,
 * so what the agent reads is exactly what the tests check. A payload goes to
 * its tool as-is once its placeholders are filled (`fillRecipe`).
 *
 * Pure data: no import, so the app's test can load this file too.
 */

export type OnboardingProfileId = 'developer' | 'automation' | 'beginner';
export type RecipeTool = 'islands_propose' | 'widgets_propose' | 'nav_propose';

export type OnboardingRecipe = {
  id: string;
  profile: OnboardingProfileId;
  tool: RecipeTool;
  /** When to propose it. */
  when: string;
  /** What the person sees once applied: the sentence to say before proposing. */
  sees: string;
  payload: Record<string, unknown>;
};

/** Values the agent fills in before sending a payload. */
export const RECIPE_PLACEHOLDERS: Record<string, string> = {
  '<project>': 'slug of the project of the tour (the one they attached, or `rooks-demo`)',
  '<chat-agent>': 'name of the agent of that project\'s chat (`project_roles` gives its coder; `agent_list` its exact name)',
  '<other-agent>': 'name of another agent of theirs, from `agent_list`',
};

const WIDGET_CARD = '@rooks/ui-layout:widget-card';
const ROUTE = { type: 'host:route' };
const TERMINAL = { type: '@rooks/terminal-web:session', params: { scope: 'project:<project>', fresh: true } };
const BROWSER = { type: '@rooks/browser-embedded:view', params: { agent: '<chat-agent>', display: 'auto' } };

/** Every product page except the cockpit and the agents. */
const ALL_BUT_HOME_AND_AGENTS = [
  '/brain', '/bots', '/projects', '/multichat', '/kanban', '/triggers', '/workflows',
  '/dreams', '/activity', '/terminal', '/capabilities', '/plugins',
];

/** A chat with nothing around it: both side columns emptied and folded. */
const BARE_CHAT = {
  view: '/chat',
  project: '',
  zones: { 'chat.left.widget': [], 'chat.right.widget': [] },
  columns: { hidden: ['chat.left.widget', 'chat.right.widget'] },
};

export const ONBOARDING_RECIPES: readonly OnboardingRecipe[] = [
  // ── Automating tasks ──────────────────────────────────────────────────────
  {
    id: 'automation.nav',
    profile: 'automation',
    tool: 'nav_propose',
    when: 'First step: a calmer side menu.',
    sees: 'The side menu keeps Cockpit, Agents, Triggers, Workflows and Activity; the other pages are hidden, not removed.',
    payload: { hidden: ['/brain', '/bots', '/projects', '/multichat', '/kanban', '/dreams', '/terminal', '/capabilities', '/plugins'] },
  },
  {
    id: 'automation.agent-view',
    profile: 'automation',
    tool: 'islands_propose',
    when: 'The agent view: their agents on the left, the chat of the one they click on the right.',
    sees: 'On the left, a full-height list of their agents; a click opens that agent\'s chat on the right.',
    payload: {
      view: '/chat',
      project: '',
      layout: {
        root: {
          dir: 'row',
          ratios: [1, 3],
          children: [
            { tabs: [{ type: WIDGET_CARD, params: { widget: 'plugin:@rooks/agents:team' } }] },
            { tabs: [ROUTE] },
          ],
        },
        focus: [1],
      },
    },
  },
  {
    id: 'automation.agent-view-widgets',
    profile: 'automation',
    tool: 'widgets_propose',
    when: 'Right after automation.agent-view is applied.',
    sees: 'The chat stands alone: its two side columns are emptied and folded.',
    payload: BARE_CHAT,
  },
  {
    id: 'automation.cockpit',
    profile: 'automation',
    tool: 'widgets_propose',
    when: 'On the cockpit (`/`), after the agent view.',
    sees: 'Left, what came in (notifications); centre, what their agents ran (recent missions); right, the work their agents have in hand (tasks).',
    payload: {
      view: '/',
      project: '',
      zones: {
        gauche: ['plugin:@rooks/agents:notifications'],
        centre: ['plugin:@rooks/missions:recent'],
        droite: ['plugin:@rooks/agents:tasks'],
      },
    },
  },

  // ── New to AI ─────────────────────────────────────────────────────────────
  {
    id: 'beginner.nav',
    profile: 'beginner',
    tool: 'nav_propose',
    when: 'Only after they said yes to a simpler screen.',
    sees: 'The side menu keeps only the Cockpit and the Agents.',
    payload: { hidden: ALL_BUT_HOME_AND_AGENTS },
  },
  {
    id: 'beginner.chat',
    profile: 'beginner',
    tool: 'widgets_propose',
    when: 'After beginner.nav.',
    sees: 'A conversation with nothing around it.',
    payload: BARE_CHAT,
  },
  {
    id: 'beginner.cockpit',
    profile: 'beginner',
    tool: 'widgets_propose',
    when: 'On the cockpit (`/`), last.',
    sees: 'One card in the middle: their agents; a click opens a conversation.',
    payload: {
      view: '/',
      project: '',
      zones: { gauche: [], centre: ['plugin:@rooks/agents:team'], droite: [] },
    },
  },

  // ── Developer ─────────────────────────────────────────────────────────────
  {
    id: 'developer.nav-all',
    profile: 'developer',
    tool: 'nav_propose',
    when: 'Only if `nav_get` shows hidden pages.',
    sees: 'Every page is back in the side menu.',
    payload: { hidden: [] },
  },
  {
    id: 'developer.cockpit',
    profile: 'developer',
    tool: 'widgets_propose',
    when: 'On the cockpit (`/`), when they want an overview of their work.',
    sees: 'Left, projects and running tasks; centre, recent missions; right, the TO DO notebook and notifications.',
    payload: {
      view: '/',
      project: '',
      zones: {
        gauche: ['plugin:@rooks/projects:overview', 'plugin:@rooks/agents:tasks'],
        centre: ['plugin:@rooks/missions:recent'],
        droite: ['plugin:@rooks/kanban:todo', 'plugin:@rooks/agents:notifications'],
      },
    },
  },
  {
    id: 'developer.code-screen',
    profile: 'developer',
    tool: 'islands_propose',
    when: 'On the project\'s chat: the whole screen in ONE card — islands and the chat\'s widget columns together, for the project AND the chat outside any project (`also_projects`). Never build it panel by panel, never a second card for the columns or for the main agent\'s chat.',
    sees: 'The agent\'s chat on two thirds of the width, with the missions and the files on its left and the project\'s TO DO and git on its right; on the remaining third, the agent\'s browser above a terminal opened in the project\'s folder. The main agent\'s chat gets the same screen.',
    payload: {
      view: '/chat',
      project: '<project>',
      also_projects: [''],
      layout: {
        root: {
          dir: 'row',
          ratios: [2, 1],
          children: [
            { tabs: [ROUTE] },
            { dir: 'column', ratios: [1, 1], children: [{ tabs: [BROWSER] }, { tabs: [TERMINAL] }] },
          ],
        },
        focus: [0],
      },
      widgets: {
        zones: {
          'chat.left.widget': ['plugin:@rooks/missions:Missions', 'plugin:@rooks/files-widget:Files'],
          'chat.right.widget': ['plugin:@rooks/kanban:project-todo', 'plugin:@rooks/git:repository'],
        },
      },
    },
  },
  {
    id: 'developer.kanban-terminal',
    profile: 'developer',
    tool: 'islands_propose',
    when: 'On the Kanban, if they want to watch tasks and run commands at once.',
    sees: 'The board on the left, a terminal in the project\'s folder on the right.',
    payload: {
      view: '/kanban',
      project: '',
      layout: {
        root: { dir: 'row', ratios: [2, 1], children: [{ tabs: [ROUTE] }, { tabs: [TERMINAL] }] },
        focus: [0],
      },
    },
  },
];

export function recipesFor(profile: OnboardingProfileId): OnboardingRecipe[] {
  return ONBOARDING_RECIPES.filter((r) => r.profile === profile);
}

/** The payload with every placeholder replaced, inside strings too (`project:<project>`). */
export function fillRecipe(payload: unknown, values: Record<string, string>): unknown {
  if (typeof payload === 'string') {
    let out = payload;
    for (const [key, value] of Object.entries(values)) out = out.split(key).join(value);
    return out;
  }
  if (Array.isArray(payload)) return payload.map((v) => fillRecipe(v, values));
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(Object.entries(payload).map(([k, v]) => [fillRecipe(k, values) as string, fillRecipe(v, values)]));
  }
  return payload;
}

/** The section a tour skill prints: what to use, when, and the exact payload. */
export function renderRecipes(profile: OnboardingProfileId): string {
  const recipes = recipesFor(profile);
  const used = Object.keys(RECIPE_PLACEHOLDERS).filter((p) => recipes.some((r) => JSON.stringify(r.payload).includes(p)));
  const lines = [
    '## Tested arrangements',
    '',
    'Propose ONLY these, never a layout of your own: each one is checked to apply. Send the payload as-is to its tool,',
    used.length ? 'after replacing the placeholders:' : 'unchanged.',
  ];
  for (const p of used) lines.push(`- \`${p}\` — ${RECIPE_PLACEHOLDERS[p]}`);
  for (const r of recipes) {
    lines.push('', `### \`${r.id}\` — \`${r.tool}\``, '', `When: ${r.when}`, `They see: ${r.sees}`, '', '```json', JSON.stringify(r.payload), '```');
  }
  return lines.join('\n');
}
