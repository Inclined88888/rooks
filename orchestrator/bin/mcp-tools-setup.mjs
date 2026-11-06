/**
 * MCP tools of the main agent's own setup conversation (CLI `timon setup …`):
 * the welcome on the TIMs page, right after the onboarding, where the agent
 * talks first to the person who just installed Timon.
 *
 * Narrow on purpose: they only work in THE setup conversation of the main
 * agent, while the step is pending, and they never change anything else. The
 * name was settled before the conversation started: do not ask for it.
 */

export const tools = [
  {
    name: 'setup_request_avatar',
    title: 'Ask the user for your picture',
    description:
      'Asks the user for a picture of you (CLI `timon setup avatar`). A card with a file picker appears in this conversation. '
      + 'Returns {status: "pending"} at once: end your turn, their answer (picture set, or not now) comes back to you as a message.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'setup_set_soul',
    title: 'Write your character',
    description:
      'Writes your character (SOUL.md) from what the user told you (CLI `timon setup soul`). `soul` is plain markdown, '
      + 'written in the first person or as rules, at most 20000 characters; `objective` is one or two sentences on what they '
      + 'expect of you. Call it again to refine. It never touches your technical instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        soul: { type: 'string', description: 'Your character and rules, markdown.' },
        objective: { type: 'string', description: 'What the user expects of you (max 2000 characters).' },
      },
      required: ['soul'],
      additionalProperties: false,
    },
  },
  {
    name: 'setup_recruit_team',
    title: 'Recruit your two teammates',
    description:
      'Creates your two teammates, a coder and a reviewer who report to you, on your folder and your model '
      + '(CLI `timon setup team --coder NAME --reviewer NAME`). Only after the user said yes. `coder` and `reviewer` are '
      + 'short first names, different from yours and from each other; a name already taken is refused (409 name_taken): pick another. '
      + 'Calling it again returns the same two.',
    inputSchema: {
      type: 'object',
      properties: {
        coder: { type: 'string', description: 'First name of the coder.' },
        reviewer: { type: 'string', description: 'First name of the reviewer.' },
      },
      required: ['coder', 'reviewer'],
      additionalProperties: false,
    },
  },
  {
    name: 'setup_finish',
    title: 'Finish the setup',
    description:
      'Ends the welcome (CLI `timon setup finish [--no-tour]`): the step is answered, your card appears on their cockpit, '
      + 'and this conversation stays open on the TIMs page. `tour`: true when the user picked the guided tour (the default), '
      + 'false otherwise. Call it once, at the end of the branch they picked, after one short sentence.',
    inputSchema: {
      type: 'object',
      properties: { tour: { type: 'boolean', description: 'Start the guided tour next (default true).' } },
      additionalProperties: false,
    },
  },
];

export const handlers = {
  async setup_request_avatar(_args, { call, env }) {
    if (!env.missionId) throw new Error('setup_request_avatar only works inside the setup conversation');
    const r = await call('POST', '/api/setup/agent/avatar-request', {});
    return { id: r.id, status: r.status, message: r.message };
  },
  async setup_set_soul(args, { call, env }) {
    if (!env.missionId) throw new Error('setup_set_soul only works inside the setup conversation');
    const body = { soul: args.soul };
    if (args.objective !== undefined) body.objective = args.objective;
    return await call('POST', '/api/setup/agent/soul', body);
  },
  async setup_recruit_team(args, { call, env }) {
    if (!env.missionId) throw new Error('setup_recruit_team only works inside the setup conversation');
    return await call('POST', '/api/setup/agent/team', { coder: args.coder, reviewer: args.reviewer });
  },
  async setup_finish(args, { call, env }) {
    if (!env.missionId) throw new Error('setup_finish only works inside the setup conversation');
    return await call('POST', '/api/setup/agent/finish', typeof args?.tour === 'boolean' ? { tour: args.tour } : {});
  },
};
