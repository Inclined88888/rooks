/**
 * MCP tools on the onboarding profile (CLI `rooks onboarding profile …`): the
 * kind of user an account chose to be (developer, automation, beginner), so an
 * agent can fit what it explains and proposes. One value per account; a mission
 * reads and writes the one of the account that launched it.
 */

const PROFILES = ['developer', 'automation', 'beginner'];

export const tools = [
  {
    name: 'onboarding_profile_get',
    title: 'Read the onboarding profile',
    description:
      'The onboarding profile the user chose (CLI `rooks onboarding profile`): "developer", "automation", "beginner", '
      + 'or null when they never chose. Fit your explanations and proposals to it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'onboarding_profile_set',
    title: 'Record the onboarding profile',
    description:
      'Records the onboarding profile the user just chose (CLI `rooks onboarding profile set <profile>`). '
      + 'Only after they answered: never guess it.',
    inputSchema: {
      type: 'object',
      properties: { profile: { type: 'string', enum: PROFILES } },
      required: ['profile'],
      additionalProperties: false,
    },
  },
];

export const handlers = {
  async onboarding_profile_get(_args, { call }) {
    return await call('GET', '/api/onboarding/profile');
  },
  async onboarding_profile_set(args, { call }) {
    return await call('PUT', '/api/onboarding/profile', { profile: args.profile });
  },
};
