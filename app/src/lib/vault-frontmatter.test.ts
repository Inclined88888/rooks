import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVaultNote, wikilinkLabel, wikilinkTarget } from './vault-frontmatter';

test('parseVaultNote lit scalaires, listes inline et corps', () => {
  const { props, body } = parseVaultNote(
    '---\ntype: topic\ncreated: 2026-04-11\ntags: [recherche, cli]\n---\n\n# GrepAI\n',
  );
  assert.deepEqual(
    props.map((p) => [p.key, p.values, p.list]),
    [
      ['type', ['topic'], false],
      ['created', ['2026-04-11'], false],
      ['tags', ['recherche', 'cli'], true],
    ],
  );
  assert.equal(body, '\n# GrepAI\n');
});

test('parseVaultNote ne casse pas les wikilinks sur leurs virgules internes', () => {
  const { props } = parseVaultNote(
    '---\nrelated: ["[[claude-code]]", "[[timon/grepai-supervision]]"]\n---\ncorps',
  );
  assert.deepEqual(props[0]?.values, ['[[claude-code]]', '[[timon/grepai-supervision]]']);
});

test('parseVaultNote lit une liste en tirets sous une clé nue', () => {
  const { props } = parseVaultNote('---\naliases:\n  - disc\n  - disque\n---\ncorps');
  assert.deepEqual(props[0], { key: 'aliases', values: ['disc', 'disque'], list: true });
});

test('parseVaultNote sans front matter rend le texte intact', () => {
  assert.deepEqual(parseVaultNote('# Titre\ntexte'), { props: [], body: '# Titre\ntexte' });
});

test('wikilinkTarget et wikilinkLabel gèrent alias et ancre', () => {
  assert.equal(wikilinkTarget('[[timon/_index|TIMON]]'), 'timon/_index');
  assert.equal(wikilinkLabel('[[timon/_index|TIMON]]'), 'TIMON');
  assert.equal(wikilinkTarget('[[note#section]]'), 'note');
  assert.equal(wikilinkTarget('topic'), null);
  assert.equal(wikilinkLabel('topic'), 'topic');
});
