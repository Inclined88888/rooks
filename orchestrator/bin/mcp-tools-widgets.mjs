/**
 * MCP tools on the user's widget arrangement (CLI `rooks widgets …`): read it,
 * propose another one, save it as a preset.
 *
 * The screen is never changed from here. `widgets_propose` raises a card in the
 * mission's conversation; the user applies or ignores it, and the answer comes
 * back as a message. Only a preset is written directly. The daemon resolves
 * whose arrangement it is from the mission token: the mission owner's, never a
 * parameter.
 */

const viewProp = {
  type: 'string',
  description: 'View pathname: "/" (cockpit), "/chat" (default: the chat of THIS mission), "/agents", or another listed in widgets_get.views.',
};
const projectProp = {
  type: 'string',
  description: 'Project of the view. Default: your agent\'s project for /chat, none elsewhere. "" = no project.',
};

export const tools = [
  {
    name: 'widgets_get',
    title: 'Read the widget layout',
    description:
      'The user\'s widget arrangement for one view (CLI `rooks widgets get`): its zones (cockpit rails `gauche`/`centre`/'
      + '`droite`, sidebars, `topbar.widget`, `chat.left.widget`/`chat.right.widget` and their tabs `<column>#<suffix>`), '
      + 'the cards placed in each zone in order (cards sharing a `stack` are tabs of one frame), the palette (cards taken '
      + 'out), the catalog of widgets this account may place (id, title, compact form, admitted zones) and, on /chat, the '
      + 'columns (order, collapsed, tabs, active tab, second column, widths, names). Read it before widgets_propose.',
    inputSchema: { type: 'object', properties: { view: viewProp, project: projectProp } },
  },
  {
    name: 'widgets_propose',
    title: 'Propose a widget layout',
    description:
      'Proposes a new widget arrangement to the user (CLI `rooks widgets propose`). Nothing changes on screen until they '
      + 'click Apply on the card shown in THIS conversation; their decision comes back to you as a message. Returns '
      + '{status: "pending"}: never propose the same arrangement twice. Declarative: each zone listed in `zones` holds '
      + 'EXACTLY the given widget ids in that order (a card left out of a listed zone goes back to the palette unless '
      + 'listed elsewhere); unlisted zones are left alone. `remove` takes cards out. On /chat, `columns` arranges the '
      + 'two columns: `order` (swap sides), `hidden` (collapse), `tabs` (a column\'s tabs beyond its first, WHOLE list: an '
      + 'existing tab left out is closed and its cards go to the column; "new:1", "new:2"… open a tab, usable as a zone '
      + 'in `zones` and as a key in `widths`/`names`), `active` (tab shown), `second` (tab shown beside the column, null '
      + 'to fold it back), `widths` (240–800 px, null = default) and `names` (tab label, max 40 characters, null = '
      + 'none). Use ids and zones from widgets_get only: unknown ones, widgets of a plugin the user was not granted, and '
      + 'a card without a compact form in `topbar.widget` are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        view: viewProp,
        project: projectProp,
        zones: {
          type: 'object',
          description: 'Zone id (or "new:<n>") → ordered widget ids. Example: {"chat.right.widget": ["plugin:@rooks/git:Git"]}.',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
        remove: { type: 'array', items: { type: 'string' }, description: 'Widget ids taken out of the interface.' },
        columns: {
          type: 'object',
          description: '/chat only. {order?, hidden?, tabs?, active?, second?, widths?, names?} — see the tool description.',
          properties: {
            order: { type: 'array', items: { type: 'string', enum: ['chat.left.widget', 'chat.right.widget'] } },
            hidden: { type: 'array', items: { type: 'string', enum: ['chat.left.widget', 'chat.right.widget'] } },
            tabs: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
            active: { type: 'object', additionalProperties: { type: 'string' } },
            second: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
            widths: { type: 'object', additionalProperties: { type: ['integer', 'null'] } },
            names: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
          },
          additionalProperties: false,
        },
        note: { type: 'string', description: 'Plain text shown on the card: why this arrangement (max 300 characters).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'widgets_preset_save',
    title: 'Save a widget layout preset',
    description:
      'Saves the CURRENT arrangement of a view as a named preset of the user\'s Layouts menu (CLI `rooks widgets '
      + 'preset-save`). Direct, no card: it changes nothing on screen. 12 presets per view, names up to 40 characters; '
      + 'an existing name is refused unless `replace` is true. To save an arrangement you proposed, wait until the user '
      + 'applied it.',
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
];

function targetQuery(args) {
  const qs = new URLSearchParams();
  if (typeof args.view === 'string') qs.set('view', args.view);
  if (typeof args.project === 'string') qs.set('project', args.project);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const handlers = {
  async widgets_get(args, { call }) {
    return await call('GET', `/api/widgets${targetQuery(args)}`);
  },
  async widgets_propose(args, { call, env }) {
    if (!env.missionId) throw new Error('widgets_propose only works inside a mission (ROOKS_MISSION_ID is not set)');
    const body = {};
    for (const key of ['view', 'project', 'zones', 'remove', 'columns', 'note']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    const r = await call('POST', '/api/widgets/proposals', body);
    return { id: r.id, status: r.status, message: r.message };
  },
  async widgets_preset_save(args, { call }) {
    const body = { name: args.name };
    for (const key of ['view', 'project', 'replace']) {
      if (args[key] !== undefined) body[key] = args[key];
    }
    return await call('POST', '/api/widgets/presets', body);
  },
};
