/**
 * MCP tools on navigation (CLI `timon navigate …`): list the pages of the app,
 * ask the user to go to one.
 *
 * By default the screen is not changed from here: `ui_navigate` raises a card
 * in the mission's conversation; the user follows it or ignores it, and the
 * answer comes back as a message. The one exception is a guided tour the user
 * started for THIS mission from their browser: the page then opens at once
 * (`status: "navigated"`). The agent cannot ask for it. The target is a path
 * of the app plus a few typed parameters, never a URL.
 *
 * `title` is the MCP display name of a tool (docs/MCP-TOOL-CONVENTIONS.md).
 */

export const tools = [
  {
    name: 'ui_routes',
    title: 'List app pages',
    description:
      'The pages of the Timon app an agent can send the user to (CLI `timon navigate routes`): path, title, the '
      + 'parameters each takes and its `origin` — "core" for the product\'s pages the user\'s permissions open, "bundled" or "third-party" (with '
      + '`plugin`, its id) for a page of a plugin the user can open, which declares no parameters. Read it before ui_navigate.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ui_navigate',
    title: 'Take the user to a page',
    description:
      'Takes the user to a page of the app (CLI `timon navigate go`). Normally nothing changes on screen until they click on '
      + 'the card shown in THIS conversation; their decision comes back to you as a message, and the status is "pending": never '
      + 'propose the same page twice. While the user runs a guided tour for this mission the page opens at once and the status '
      + 'is "navigated". You cannot start a tour yourself. `path` from ui_routes (a product page the user cannot open is refused), '
      + '`params` only the ones that page declares (e.g. /settings '
      + '{section}, /chat {mission}).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'App path, e.g. "/kanban", "/settings".' },
        params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Typed parameters of that page.' },
        note: { type: 'string', description: 'Plain text shown on the card: why go there (max 300 characters).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'nav_get',
    title: 'Read the side menu',
    description:
      'The side menu of the user (CLI `timon nav get`): the pages hidden from it, its layout (`order`: the main list top '
      + 'to bottom, `footer`: the bottom of the menu above Settings, both paths and "---" separators, `null` if never laid '
      + 'out) and the product\'s menu entries (path, title). A hidden page still opens by its address. Read it before nav_propose.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'nav_propose',
    title: 'Propose a side menu',
    description:
      'Proposes a side menu (CLI `timon nav propose`), at least one of: `hidden`, the COMPLETE list of hidden pages once '
      + 'applied (`[]` shows every page again); `order`, the main list top to bottom; `footer`, the pages at the bottom of '
      + 'the menu, above Settings. `order` and `footer` are paths and "---" (a separator, shown as a gap); a list left out '
      + 'keeps what the menu has, a page neither list names shows at the end of the main list. Nothing changes until the '
      + 'user applies the card shown in THIS conversation; their decision comes back to you as a message. Hide only what '
      + 'the person does not need: the menu always offers to show every page again.',
    inputSchema: {
      type: 'object',
      properties: {
        hidden: { type: 'array', items: { type: 'string' }, maxItems: 64, description: 'Paths of the pages to hide, e.g. ["/kanban", "/terminal"].' },
        order: { type: 'array', items: { type: 'string' }, maxItems: 96, description: 'The main list, top to bottom, e.g. ["/", "/agents", "---", "/kanban"].' },
        footer: { type: 'array', items: { type: 'string' }, maxItems: 96, description: 'The pages at the bottom of the menu, above Settings, e.g. ["/plugins"].' },
        note: { type: 'string', description: 'Plain text shown on the card (max 300 characters).' },
      },
      additionalProperties: false,
    },
  },
];

export const handlers = {
  async ui_routes(_args, { call }) {
    return await call('GET', '/api/navigate/routes');
  },
  async ui_navigate(args, { call, env }) {
    if (!env.missionId) throw new Error('ui_navigate only works inside a mission (TIMON_MISSION_ID is not set)');
    const body = {};
    for (const key of ['path', 'params', 'note']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const r = await call('POST', '/api/navigate/proposals', body);
    return { id: r.id, status: r.status, message: r.message, ...(r.warnings ? { warnings: r.warnings } : {}) };
  },
  async nav_get(_args, { call }) {
    return await call('GET', '/api/nav');
  },
  async nav_propose(args, { call, env }) {
    if (!env.missionId) throw new Error('nav_propose only works inside a mission (TIMON_MISSION_ID is not set)');
    const body = {};
    for (const key of ['hidden', 'order', 'footer', 'note']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const r = await call('POST', '/api/nav/proposals', body);
    return { id: r.id, status: r.status, message: r.message, ...(r.warnings ? { warnings: r.warnings } : {}) };
  },
};
