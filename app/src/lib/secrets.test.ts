import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  addGrant,
  buildBrokerSpec,
  blankEditor,
  buildCreatePayload,
  buildUpdatePayload,
  configuredLabelKey,
  editorErrorKey,
  editorFromSecret,
  filterSecrets,
  grantKey,
  isDaemonOnly,
  removeGrant,
  parseBrokerSpec,
  parseHosts,
  presetFromSpec,
  scopeBadge,
  consentTarget,
  grantFromChoice,
  grantedToPlugin,
  pluginGrantRequest,
  pluginOfGrant,
  setEditorMode,
  setEditorPreset,
  sortSecrets,
  type SecretEditor,
  type SecretSummary,
} from './secrets';
import { SCOPE_CHOICES, grantableBackends, hasReservation, isBrokerErrorKey, scopeChoicesFor } from './secrets';

const SECRET: SecretSummary = {
  id: 's1',
  name: 'GITHUB_TOKEN',
  mode: 'inject',
  grants: [
    { scope_kind: 'project', scope_ref: 'initech' },
    { scope_kind: 'agent', scope_ref: 'umbrella.coder' },
  ],
  configured: true,
  updated_at: 1_756_500_000_000,
  note: 'CI',
};

const fakeT = (key: string) => key.split('.').pop() ?? key;

test('loading an existing secret leaves the value field empty', () => {
  const editor = editorFromSecret(SECRET);
  assert.equal(editor.value, '');
  assert.equal(editor.replacingValue, false);
  // The summary type carries no value at all: nothing to pre-fill from.
  assert.equal('value' in SECRET, false);
});

test('an untouched value is absent from the update payload', () => {
  const editor = editorFromSecret(SECRET);
  const payload = buildUpdatePayload(editor);
  assert.equal('value' in payload, false);
  assert.deepEqual(payload.grants, SECRET.grants);

  const replacing = buildUpdatePayload({ ...editor, replacingValue: true, value: 'ghp_new' });
  assert.equal(replacing.value, 'ghp_new');
});

test('a creation always carries its value', () => {
  const payload = buildCreatePayload({ ...blankEditor(), name: 'API_KEY', value: 'abc' });
  assert.deepEqual(payload, { name: 'API_KEY', mode: 'inject', note: null, grants: [], value: 'abc' });
});

test('scope badges mirror the grants returned by the API', () => {
  assert.deepEqual(
    SECRET.grants.map((g) => scopeBadge(g, fakeT)),
    ['project: initech', 'agent: umbrella.coder'],
  );
  assert.equal(scopeBadge({ scope_kind: 'global', scope_ref: null }, fakeT), 'global');
  // A global grant never shows a reference, even if the API sent one.
  assert.equal(scopeBadge({ scope_kind: 'global', scope_ref: 'x' }, fakeT), 'global');
  // A provider's key, reserved to its backend (TODO #531, 5-B): shown, with its id.
  assert.equal(scopeBadge({ scope_kind: 'backend', scope_ref: 'acme-llm' }, fakeT), 'backend: acme-llm');
});

test('a secret without any grant is daemon-only', () => {
  assert.equal(isDaemonOnly({ grants: [] }), true);
  assert.equal(isDaemonOnly(SECRET), false);
});

test('the configured state drives its own label', () => {
  assert.equal(configuredLabelKey(SECRET), 'secretsPage.configured');
  assert.equal(configuredLabelKey({ ...SECRET, configured: false }), 'secretsPage.notConfigured');
});

test('a row without a stored value opens straight on the input', () => {
  const editor = editorFromSecret({ ...SECRET, configured: false });
  // Nothing to keep, so nothing to *Replace* — but still no value to show.
  assert.equal(editor.replacingValue, true);
  assert.equal(editor.value, '');
  assert.equal(editorErrorKey(editor), 'secretsPage.error.value');
});

test('grants are deduplicated and removable by key', () => {
  let grants = addGrant([], { scope_kind: 'project', scope_ref: 'initech' });
  grants = addGrant(grants, { scope_kind: 'project', scope_ref: 'initech' });
  assert.equal(grants.length, 1);
  grants = addGrant(grants, { scope_kind: 'global' });
  assert.deepEqual(grants[1], { scope_kind: 'global', scope_ref: null });
  // A project/agent grant without a reference could never match: refused.
  assert.equal(addGrant(grants, { scope_kind: 'agent', scope_ref: '  ' }).length, 2);
  assert.deepEqual(removeGrant(grants, grantKey({ scope_kind: 'global' })), [
    { scope_kind: 'project', scope_ref: 'initech' },
  ]);
});

test('the name is validated as an environment variable identifier', () => {
  const editor = { ...blankEditor(), value: 'v' };
  assert.equal(editorErrorKey({ ...editor, name: 'GITHUB_TOKEN' }), null);
  assert.equal(editorErrorKey({ ...editor, name: 'github_token' }), 'secretsPage.error.name');
  assert.equal(editorErrorKey({ ...editor, name: '1TOKEN' }), 'secretsPage.error.name');
  assert.equal(editorErrorKey({ ...editor, name: 'TOKEN', value: '' }), 'secretsPage.error.value');
  // Editing metadata without replacing the value stays submittable.
  assert.equal(
    editorErrorKey({ ...editor, name: 'TOKEN', value: '', replacingValue: false }),
    null,
  );
});

test('the list is sorted by name', () => {
  const sorted = sortSecrets([
    { ...SECRET, id: 'b', name: 'ZED' },
    { ...SECRET, id: 'a', name: 'ALPHA' },
  ]);
  assert.deepEqual(sorted.map((s) => s.name), ['ALPHA', 'ZED']);
});

/** A broker editor filled the way the form does, ready to be submitted. */
function brokerEditor(over: Partial<SecretEditor> = {}): SecretEditor {
  return {
    ...blankEditor(),
    name: 'GITHUB_TOKEN',
    value: 'ghp_x',
    mode: 'broker',
    brokerPreset: 'bearer',
    brokerHosts: 'api.github.com',
    ...over,
  };
}

test('a broker creation carries its broker_spec', () => {
  const payload = buildCreatePayload(brokerEditor());
  assert.deepEqual(payload.broker_spec, {
    type: 'http',
    hosts: ['api.github.com'],
    inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
  });
  // An inject secret has no spec at all — not even a null key on the wire.
  assert.equal('broker_spec' in buildCreatePayload({ ...brokerEditor(), mode: 'inject' }), false);
});

test('each preset produces the matching broker_spec', () => {
  assert.deepEqual(buildBrokerSpec(brokerEditor({ brokerPreset: 'bearer' })), {
    type: 'http',
    hosts: ['api.github.com'],
    inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
  });
  assert.deepEqual(
    buildBrokerSpec(brokerEditor({ brokerPreset: 'header', brokerHeaderName: 'X-Api-Key' })),
    {
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'header', name: 'X-Api-Key', template: '{{value}}' },
    },
  );
  assert.deepEqual(
    buildBrokerSpec(brokerEditor({ brokerPreset: 'query', brokerQueryName: 'access_token' })),
    {
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'query', name: 'access_token', template: '{{value}}' },
    },
  );
  assert.deepEqual(buildBrokerSpec(brokerEditor({ brokerPreset: 'git' })), {
    type: 'git',
    hosts: ['api.github.com'],
  });
  assert.deepEqual(
    buildBrokerSpec(
      brokerEditor({
        brokerPreset: 'advanced',
        brokerHeaderName: 'X-Token',
        brokerTemplate: 'tok {{value}}',
      }),
    ),
    {
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'header', name: 'X-Token', template: 'tok {{value}}' },
    },
  );
});

test('a git broker still needs an allowlist', () => {
  const editor = brokerEditor({ brokerPreset: 'git', brokerHosts: '' });
  assert.equal(editorErrorKey(editor), 'secretsPage.error.brokerHosts');
  assert.equal(editorErrorKey(brokerEditor({ brokerPreset: 'git' })), null);
});

test('an incomplete broker is refused before it reaches the API', () => {
  assert.equal(editorErrorKey(brokerEditor({ brokerHosts: '  ' })), 'secretsPage.error.brokerHosts');
  assert.equal(
    editorErrorKey(brokerEditor({ brokerHosts: 'https://api.github.com/x' })),
    'secretsPage.error.brokerHostFormat',
  );
  // An unfilled preset: custom header without a name, query without a param.
  assert.equal(
    editorErrorKey(brokerEditor({ brokerPreset: 'header', brokerHeaderName: ' ' })),
    'secretsPage.error.brokerHeader',
  );
  assert.equal(
    editorErrorKey(brokerEditor({ brokerPreset: 'query', brokerQueryName: '' })),
    'secretsPage.error.brokerQuery',
  );
  // Without the placeholder the daemon would send a header holding no secret.
  assert.equal(
    editorErrorKey(
      brokerEditor({ brokerPreset: 'advanced', brokerHeaderName: 'X', brokerTemplate: 'Bearer hardcoded' }),
    ),
    'secretsPage.error.brokerTemplate',
  );
  assert.equal(editorErrorKey(brokerEditor()), null);
  // Bearer needs no extra field — the name and template are the preset.
  assert.equal(editorErrorKey(brokerEditor({ brokerPreset: 'bearer', brokerHeaderName: '' })), null);
});

test('hosts are parsed from free text, deduplicated and lowercased', () => {
  assert.deepEqual(parseHosts(' api.github.com, .github.com\nAPI.GITHUB.COM '), [
    'api.github.com',
    '.github.com',
  ]);
  assert.deepEqual(parseHosts('   '), []);
});

test('a returned broker spec seeds the form', () => {
  // S.5 hands the spec back as the JSON text it stored, not as an object.
  const editor = editorFromSecret({
    ...SECRET,
    mode: 'broker',
    broker_spec: JSON.stringify({
      type: 'http',
      hosts: ['api.github.com', 'uploads.github.com'],
      inject: { kind: 'header', name: 'X-Token', template: 'tok {{value}}' },
    }),
  });
  assert.equal(editor.brokerSpecKnown, true);
  assert.equal(editor.brokerPreset, 'advanced');
  assert.equal(editor.brokerHosts, 'api.github.com\nuploads.github.com');
  assert.equal(editor.brokerHeaderName, 'X-Token');
  assert.equal(editor.brokerTemplate, 'tok {{value}}');
});

test('a stored spec reopens on the matching preset', () => {
  assert.equal(
    presetFromSpec({
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
    }),
    'bearer',
  );
  assert.equal(
    presetFromSpec({
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'header', name: 'X-Api-Key', template: '{{value}}' },
    }),
    'header',
  );
  assert.equal(
    presetFromSpec({
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'query', name: 'token', template: '{{value}}' },
    }),
    'query',
  );
  assert.equal(presetFromSpec({ type: 'git', hosts: ['github.com'] }), 'git');
});

test('a spec this form cannot represent is kept, not rebuilt', () => {
  assert.equal(parseBrokerSpec('{ not json'), null);
  assert.equal(parseBrokerSpec('{"type":"smtp"}'), null);
  assert.deepEqual(parseBrokerSpec('{"type":"git"}'), { type: 'git', hosts: [] });
  // S.5 validates only that a spec exists, so a stored `http` without hosts is
  // reachable: it must reopen the form on what is there, not on nothing.
  assert.deepEqual(parseBrokerSpec('{"type":"http","hosts":[]}'), {
    type: 'http',
    hosts: [],
    inject: { kind: 'header', name: '', template: '' },
  });
  // An inject kind this form does not name: keep the stored spec.
  assert.equal(
    parseBrokerSpec('{"type":"http","hosts":["x.com"],"inject":{"kind":"body","name":"x"}}'),
    null,
  );
});

test('editing the grants of a broker whose spec the API withheld keeps it', () => {
  const editor = editorFromSecret({ ...SECRET, mode: 'broker' });
  assert.equal(editor.brokerSpecKnown, false);
  // Rebuilding a spec out of blank fields would erase the host allowlist.
  assert.equal(buildBrokerSpec(editor), null);
  const payload = buildUpdatePayload({
    ...editor,
    grants: addGrant(editor.grants, { scope_kind: 'global' }),
  });
  assert.equal('broker_spec' in payload, false);
  assert.equal(editorErrorKey(editor), null);
});

test('turning an inject secret into a broker asks for a spec', () => {
  const editor = setEditorMode(editorFromSecret(SECRET), 'broker');
  assert.equal(editor.brokerSpecKnown, true);
  // Nothing is stored to fall back on, so the empty allowlist is an error.
  assert.equal(editorErrorKey(editor), 'secretsPage.error.brokerHosts');
  assert.equal(setEditorPreset(editor, 'git').brokerPreset, 'git');
});

test('an update that does not click Replace still omits value', () => {
  const editor = editorFromSecret({
    ...SECRET,
    mode: 'broker',
    broker_spec: JSON.stringify({
      type: 'http',
      hosts: ['api.github.com'],
      inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
    }),
  });
  const payload = buildUpdatePayload(editor);
  assert.equal('value' in payload, false);
  assert.ok(payload.broker_spec);
});

test('filterSecrets matches name, note, mode and scopes, every word', () => {
  const list = [
    { id: '1', name: 'COOLIFY_API_TOKEN', mode: 'broker', grants: [{ scope_kind: 'project', scope_ref: 'nimbus' }], configured: true, updated_at: 1, note: 'deploy' },
    { id: '2', name: 'HUGGING_FACE_TOKEN', mode: 'inject', grants: [{ scope_kind: 'global', scope_ref: null }], configured: true, updated_at: 1 },
    { id: '3', name: 'LOCAL_ONLY', mode: 'inject', grants: [], configured: true, updated_at: 1 },
  ] as SecretSummary[];
  assert.equal(filterSecrets(list, '').length, 3);
  assert.deepEqual(filterSecrets(list, 'coolify').map((s) => s.id), ['1']);
  assert.deepEqual(filterSecrets(list, 'token global').map((s) => s.id), ['2']);
  assert.deepEqual(filterSecrets(list, 'project nimbus').map((s) => s.id), ['1']);
  assert.deepEqual(filterSecrets(list, 'deploy').map((s) => s.id), ['1']);
  assert.deepEqual(filterSecrets(list, 'daemon').map((s) => s.id), ['3']);
  assert.equal(filterSecrets(list, 'nope').length, 0);
});

/* ── Plugins as grantees (TODO #597) ── */

test('picking a plugin produces the agent grant the daemon resolves for it', () => {
  assert.deepEqual(grantFromChoice('plugin', ' acme-connector '), { scope_kind: 'agent', scope_ref: 'plugin:acme-connector' });
  assert.deepEqual(grantFromChoice('agent', 'timon.coder'), { scope_kind: 'agent', scope_ref: 'timon.coder' });
  assert.deepEqual(grantFromChoice('global', 'ignored'), { scope_kind: 'global', scope_ref: null });
  // No plugin installed: nothing to add, never a grant to the bare `plugin:` address.
  assert.deepEqual(addGrant([], grantFromChoice('plugin', '')), []);
  assert.deepEqual(addGrant([], grantFromChoice('plugin', '  ')), []);
});

test('a plugin grant reads as a plugin, not as an agent with a strange name', () => {
  const grant = { scope_kind: 'agent' as const, scope_ref: 'plugin:acme' };
  assert.equal(pluginOfGrant(grant), 'acme');
  assert.equal(pluginOfGrant({ scope_kind: 'agent', scope_ref: 'timon.coder' }), null);
  assert.equal(pluginOfGrant({ scope_kind: 'project', scope_ref: 'plugin:acme' }), null);
  assert.equal(pluginOfGrant({ scope_kind: 'agent', scope_ref: 'plugin:' }), null);
  assert.equal(scopeBadge(grant, fakeT), 'plugin: acme');
  assert.equal(scopeBadge({ scope_kind: 'agent', scope_ref: 'timon.coder' }, fakeT), 'agent: timon.coder');
});

test('the consent request is read from the URL, and only when well-formed', () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(pluginGrantRequest(q('grant=GITHUB_TOKEN&plugin=%40acme%2Ftodo')), { name: 'GITHUB_TOKEN', plugin: '@acme/todo' });
  assert.equal(pluginGrantRequest(q('grant=github_token&plugin=acme')), null);
  assert.equal(pluginGrantRequest(q('grant=GITHUB_TOKEN')), null);
  assert.equal(pluginGrantRequest(q('plugin=acme')), null);
  assert.equal(pluginGrantRequest(q('')), null);
});

test('the card is about the row shared `global`; otherwise one row, or the operator chooses', () => {
  const row = (id: string, grants: SecretSummary['grants']): SecretSummary => ({ ...SECRET, id, grants });
  const shared = row('g', [{ scope_kind: 'global', scope_ref: null }]);
  const project = row('p', [{ scope_kind: 'project', scope_ref: 'alpha' }]);
  const other = { ...row('o', []), name: 'OTHER' };
  assert.equal(consentTarget([project, shared, other], 'GITHUB_TOKEN').secret?.id, 'g');
  assert.equal(consentTarget([project, other], 'GITHUB_TOKEN').secret?.id, 'p');
  const ambiguous = consentTarget([project, row('q', [])], 'GITHUB_TOKEN');
  assert.equal(ambiguous.secret, null);
  assert.deepEqual(ambiguous.candidates.map((s) => s.id), ['p', 'q']);
  assert.deepEqual(consentTarget([other], 'GITHUB_TOKEN'), { secret: null, candidates: [] });
});

test('a grant to one plugin is not a grant to another, nor to an agent of the same name', () => {
  const s = { grants: [{ scope_kind: 'agent' as const, scope_ref: 'plugin:acme' }, { scope_kind: 'agent' as const, scope_ref: 'beta' }] };
  assert.equal(grantedToPlugin(s, 'acme'), true);
  assert.equal(grantedToPlugin(s, 'beta'), false);
  assert.equal(grantedToPlugin(s, 'acme-two'), false);
});

test('a key is reserved to a backend through the same picker, by its id', () => {
  assert.ok(SCOPE_CHOICES.includes('backend'));
  assert.deepEqual(grantFromChoice('backend', 'opencode'), { scope_kind: 'backend', scope_ref: 'opencode' });
  assert.deepEqual(addGrant([], grantFromChoice('backend', '')), [], 'no backend picked, no reservation on nobody');
  assert.equal(hasReservation([{ scope_kind: 'project', scope_ref: 'alpha' }]), false);
  assert.equal(hasReservation([{ scope_kind: 'backend', scope_ref: 'opencode' }]), true);
});

test('the backends offered: every installed one first, never an account instance', () => {
  assert.deepEqual(
    grantableBackends(
      [{ id: 'opencode', label: 'OpenCode' }, { id: 'claude', label: 'Claude' }],
      [{ id: 'claude', label: 'Claude Code' }, { id: 'claude@krz', label: 'Claude', instanceOf: 'claude' }, { id: 'custom', label: 'custom' }],
    ),
    [
      { value: 'opencode', label: 'OpenCode (opencode)' },
      { value: 'claude', label: 'Claude (claude)' },
      { value: 'custom', label: 'custom' },
    ],
  );
  // A caller refused the installed list still gets what the catalogue lists.
  assert.deepEqual(grantableBackends([], [{ id: 'claude' }]), [{ value: 'claude', label: 'claude' }]);
  // An id written by hand, without `instanceOf`: the `@` says the same.
  assert.deepEqual(grantableBackends([{ id: 'claude@krz' }], []), []);
});

test('a brokered secret is neither offered a reservation nor saved with one', () => {
  assert.ok(scopeChoicesFor('inject').includes('backend'));
  assert.ok(!scopeChoicesFor('broker').includes('backend'));
  const editor = { ...blankEditor(), name: 'API_KEY', value: 'abc', grants: [{ scope_kind: 'backend' as const, scope_ref: 'opencode' }] };
  assert.equal(editorErrorKey(editor), null, 'injected: the daemon hands it to that backend');
  const broker = { ...editor, mode: 'broker' as const, brokerHosts: 'api.example.com' };
  assert.equal(editorErrorKey(broker), 'secretsPage.error.brokerReserved', 'brokered: no request could ever use it');
  assert.equal(isBrokerErrorKey('secretsPage.error.brokerReserved'), true);
  assert.equal(editorErrorKey({ ...broker, grants: [] }), null);
});

