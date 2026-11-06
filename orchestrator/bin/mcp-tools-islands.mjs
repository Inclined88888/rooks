/**
 * MCP tools on the user's island workspace (CLI `timon islands …`): read it,
 * propose another arrangement (or recall a named one), save the view as a
 * preset, list and save the account's named arrangements.
 *
 * The screen is never changed from here. `islands_propose` raises a card in the
 * mission's conversation; the user applies or ignores it, and the answer comes
 * back as a message. Only a preset and a named arrangement are written directly. The daemon resolves
 * whose workspace it is from the mission token: the mission owner's, never a
 * parameter.
 */

const viewProp = {
  type: 'string',
  description: 'View pathname: "/chat" (default: the chat of THIS mission), "/" (cockpit), "/kanban", "/terminal"… Every page with the top bar has its own workspace.',
};
const projectProp = {
  type: 'string',
  description: 'Project of the view. Default: your agent\'s project for /chat, none elsewhere. "" = no project.',
};
const contentSchema = {
  type: 'object',
  description: 'A content: {type, params}. `type` from islands_get.types; params as that type declares them.',
  properties: {
    type: { type: 'string' },
    params: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
  },
  required: ['type'],
  additionalProperties: false,
};

export const tools = [
  {
    name: 'islands_get',
    title: 'Read the island layout',
    description:
      'The user\'s island workspace for one view (CLI `timon islands get`): the tree of islands (splits `row` = side by side, '
      + '`column` = stacked, with their ratios; each island a stack of tabs, the active one marked), the focused island, the '
      + 'limits (8 islands, 3 levels of split, 12 tabs per island, 32 tabs, 1 KiB of params per tab) and the content types '
      + 'this account may open, with the params each declares. `host:route` is the view\'s own page: present exactly once. '
      + 'Read it before islands_propose.',
    inputSchema: { type: 'object', properties: { view: viewProp, project: projectProp } },
  },
  {
    name: 'islands_propose',
    title: 'Propose an island layout',
    description:
      'Proposes an island arrangement to the user (CLI `timon islands propose`). Nothing changes on screen until they click '
      + 'Apply on the card shown in THIS conversation; their decision comes back to you as a message. Returns {status: '
      + '"pending"}: never propose the same arrangement twice. Exactly one of: `arrangement` — the id of one of the user\'s '
      + 'named arrangements (islands_arrangements_list), laid on the view as their Island arrangements menu would: the card '
      + 'shows its name and schematic, and nothing else goes with it (no `layout`, `open`, `widgets` nor `also_projects`); '
      + 'an id the account does not hold is refused (404). `open` — one content against an island\'s '
      + 'edge (`left`/`right`/`top`/`bottom`, a new island) or in it as a tab (`center`); `island` is an island id from '
      + 'islands_get, the focused island by default; a content already open (same session…) moves instead of doubling. '
      + '`layout` — the WHOLE workspace: `root` is a node, either an island {tabs: [content, …], active?: index} or a split '
      + '{dir: "row"|"column", children: [node, …] (2+), ratios?: [weights]}; it must hold {type: "host:route"} exactly '
      + 'once; `focus` is the path of child indexes to the island to focus ([1, 0]). Contents already on screen keep their '
      + 'place in memory (no reload); a tab the layout leaves out is closed on Apply, on every '
      + 'project the card names, and a terminal ends its shell: list every session to keep. Types and params from islands_get only: an unknown type, a type of a plugin the user '
      + 'was not granted, undeclared or invalid params, and anything past the limits are refused. `widgets` adds the view\'s '
      + 'widget columns to the same card: one Apply sets the whole screen.',
    inputSchema: {
      type: 'object',
      properties: {
        view: viewProp,
        project: projectProp,
        arrangement: {
          type: 'string',
          description: 'Id of a named arrangement from islands_arrangements_list, recalled on the view. Alone: no `layout`, `open`, `widgets` nor `also_projects`.',
        },
        open: {
          type: 'object',
          properties: {
            content: contentSchema,
            edge: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'center'] },
            island: { type: 'string', description: 'Island id from islands_get (default: the focused island).' },
          },
          required: ['content', 'edge'],
          additionalProperties: false,
        },
        layout: {
          type: 'object',
          description: '{root: node, focus?: [indexes]} — see the tool description. Example: {"root": {"dir": "row", "ratios": [2, 1], '
            + '"children": [{"tabs": [{"type": "host:route"}]}, {"tabs": [{"type": "@timon/terminal-web:session", "params": {"sessionId": "…"}}]}]}}',
          properties: {
            root: { type: 'object' },
            focus: { type: 'array', items: { type: 'integer' } },
          },
          required: ['root'],
          additionalProperties: false,
        },
        widgets: {
          type: 'object',
          description: 'Optional: the same view\'s widget columns, applied in the SAME card as the islands — set a whole screen '
            + 'up in one validation. Same fields as widgets_propose: `zones` ({zone: [widget ids]}), `columns`, `remove`.',
          properties: {
            zones: { type: 'object' },
            columns: { type: 'object' },
            remove: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        also_projects: {
          type: 'array',
          items: { type: 'string' },
          description: 'With `layout` only: other projects of the same view the SAME Apply sets up too ("" = no project, e.g. '
            + 'the main agent\'s chat). Max 4. Each gets the same islands and columns.',
        },
        note: { type: 'string', description: 'Plain text shown on the card: why this arrangement (max 300 characters).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'islands_preset_save',
    title: 'Save an island layout preset',
    description:
      'Saves the CURRENT arrangement of a view — its islands with its widgets and columns — as a named preset of the user\'s '
      + 'Layouts menu (CLI `timon islands preset-save`, same preset as widgets_preset_save). Direct, no card: it changes '
      + 'nothing on screen. 12 presets per view, names up to 40 characters; an existing name is refused unless `replace` is '
      + 'true. To save an arrangement you proposed, wait until the user applied it.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Preset name (max 40 characters).' },
        view: viewProp,
        project: projectProp,
        replace: { type: 'boolean', description: 'Overwrite the preset of the same name.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'islands_arrangements_list',
    title: 'List the named island arrangements',
    description:
      'The user\'s named island arrangements (CLI `timon islands arrangements`): island layouts kept under a name for the '
      + 'whole account, not for one view — any view can take one, and each is a page of its own at `href` (/islands/<id>), '
      + 'shown in the main menu when `menu` is true. Each comes with a summary (islands, popups, tabs, the contents besides '
      + 'the page); `full: true` adds each tree, in the shape islands_get uses. Read it before islands_arrangement_save.',
    inputSchema: {
      type: 'object',
      properties: { full: { type: 'boolean', description: 'Include each arrangement\'s tree.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'islands_arrangement_save',
    title: 'Save a named island arrangement',
    description:
      'Keeps an island layout under a name in the user\'s Island arrangements menu (CLI `timon islands arrangement-save`). Direct, '
      + 'no card: it changes nothing on screen and is never added to the main menu (the user does that, from the same menu). Either the CURRENT '
      + 'islands of a view (`view`/`project`, default the chat of this mission) or a `layout` you write, in the format and '
      + 'with the checks of islands_propose. The day\'s state of each tab (a chat\'s conversation, a terminal\'s shell) is '
      + 'never kept. 12 arrangements per account, names up to 40 characters; an existing name is refused unless `replace` '
      + 'is true (same id, same page, new tree); a view showing nothing but its page is refused (`empty-tree`). The user\'s '
      + 'open menu shows it the next time it reads the list.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Arrangement name (max 40 characters).' },
        replace: { type: 'boolean', description: 'Give the arrangement of the same name this tree.' },
        view: viewProp,
        project: projectProp,
        layout: {
          type: 'object',
          description: '{root: node, focus?: [indexes]} as in islands_propose; exclusive of `view`/`project`.',
          properties: {
            root: { type: 'object' },
            focus: { type: 'array', items: { type: 'integer' } },
          },
          required: ['root'],
          additionalProperties: false,
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

function targetQuery(args) {
  const qs = new URLSearchParams();
  if (typeof args.view === 'string') qs.set('view', args.view);
  if (typeof args.project === 'string') qs.set('project', args.project);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const handlers = {
  async islands_get(args, { call }) {
    return await call('GET', `/api/islands${targetQuery(args)}`);
  },
  async islands_propose(args, { call, env }) {
    if (!env.missionId) throw new Error('islands_propose only works inside a mission (TIMON_MISSION_ID is not set)');
    const body = {};
    for (const key of ['view', 'project', 'arrangement', 'open', 'layout', 'widgets', 'also_projects', 'note']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const r = await call('POST', '/api/islands/proposals', body);
    return { id: r.id, status: r.status, message: r.message, ...(r.warnings ? { warnings: r.warnings } : {}) };
  },
  async islands_preset_save(args, { call }) {
    const body = { name: args.name };
    for (const key of ['view', 'project', 'replace']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    // A preset is the view's: the same capture as the widgets', `.islands` included.
    return await call('POST', '/api/widgets/presets', body);
  },
  async islands_arrangements_list(args, { call }) {
    return await call('GET', `/api/islands/arrangements${args.full === true ? '?full=1' : ''}`);
  },
  async islands_arrangement_save(args, { call }) {
    const body = { name: args.name };
    for (const key of ['replace', 'view', 'project', 'layout']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    return await call('POST', '/api/islands/arrangements', body);
  },
};
