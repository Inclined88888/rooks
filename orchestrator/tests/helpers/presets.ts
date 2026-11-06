/**
 * The two ordinary roles the core used to create at first-run setup
 * (`docs/MULTI-USER.md` §4), kept for the tests that give an account the
 * rights of an employee or an administrator. The Multi-user plugin poses its
 * own presets; the core no longer creates any role.
 *
 * `key` is never stored: it names a preset in code, so a test does not break
 * (or stop running its access checks) when a display name is reworded.
 */
export const SETUP_ROLE_PRESETS: ReadonlyArray<{
  key: 'administration' | 'employee';
  name: string;
  description: string;
  permissions: readonly string[];
}> = [
  {
    key: 'administration',
    name: 'Administration',
    description: 'Everything except managing user accounts',
    permissions: ['*', '-users:manage'],
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Spawn and read own missions, home and chat',
    permissions: [
      'missions:spawn',
      'missions:read',
      'missions:stop',
      'trace:read',
      'page:/',
      'page:/chat',
      // The chat's own cards: its missions and their traces (TODO #645).
      'widget:missions',
      'widget:workflows',
      'layout:ui-layout',
      'theme:ui-theme',
      'theme:theme-timon',
    ],
  },
];
