/**
 * `engines.node` against the daemon's Node (TODO #763): the range forms npm
 * documents, the "let it through" answer for what is unreadable, and the
 * refusal message that names both versions and the packaged runtime.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeEngineProblem, nodeEngineRange, nodeRangeSatisfied, type NodeRuntimeFacts } from './node-engine.js';

const ELECTRON_33: NodeRuntimeFacts = { node: '20.18.3', electron: '33.4.11', packaged: true, source: 'daemon' };

test('a plugin engine range: >=22.5 excludes Electron 33 and admits Node 22.5+', () => {
  assert.equal(nodeRangeSatisfied('>=22.5', '20.18.3'), false);
  assert.equal(nodeRangeSatisfied('>=22.5', '22.5.0'), true);
  assert.equal(nodeRangeSatisfied('>=22.5', '24.1.0'), true);
  assert.equal(nodeRangeSatisfied('>= 22.5.0', '22.4.9'), false);
});

test('the range forms npm documents', () => {
  const cases: Array<[string, string, boolean]> = [
    ['^20.0.0', '20.18.3', true], ['^20.0.0', '21.0.0', false], ['^20', '20.0.0', true],
    ['^0.2.3', '0.2.9', true], ['^0.2.3', '0.3.0', false], ['^0.0.3', '0.0.4', false],
    ['~20.18', '20.18.9', true], ['~20.18', '20.19.0', false], ['~20', '20.99.0', true],
    ['20.x', '20.1.0', true], ['20.x', '21.0.0', false], ['20', '20.5.0', true], ['*', '1.0.0', true], ['', '1.0.0', true],
    ['>=18 <21', '20.18.3', true], ['>=18 <21', '21.0.0', false],
    ['^18.17.0 || >=20.5.0', '20.18.3', true], ['^18.17.0 || >=20.5.0', '19.0.0', false],
    ['18 - 20', '20.9.0', true], ['18 - 20', '21.0.0', false], ['18.1.0 - 20.2.0', '20.2.1', false],
    ['>20', '20.9.9', false], ['>20', '21.0.0', true], ['<=20', '20.9.9', true], ['<=20.2', '20.3.0', false],
    ['=20.18.3', '20.18.3', true], ['v20.18.3', '20.18.4', false], ['>=22.5.0-beta', '22.5.0', true],
  ];
  for (const [range, version, expected] of cases) {
    assert.equal(nodeRangeSatisfied(range, version), expected, `${range} vs ${version}`);
  }
});

test('an unreadable range or version is not an answer, so never a refusal', () => {
  assert.equal(nodeRangeSatisfied('latest', '20.18.3'), null);
  assert.equal(nodeRangeSatisfied('>=22 || banana', '20.18.3'), null);
  assert.equal(nodeRangeSatisfied('>=22', 'not-a-version'), null);
  assert.equal(nodeEngineProblem({ engines: { node: 'whatever' } }, 'acme', ELECTRON_33), null);
});

test('engines.node is read from the package root, absent or empty reads null', () => {
  assert.equal(nodeEngineRange({ engines: { node: ' >=22.5 ' } }), '>=22.5');
  assert.equal(nodeEngineRange({ engines: { node: '' } }), null);
  assert.equal(nodeEngineRange({ engines: { npm: '>=10' } }), null);
  assert.equal(nodeEngineRange({ rooks: { engines: { node: '>=22' } } }), null);
  assert.equal(nodeEngineRange(null), null);
});

test('the refusal names both versions and says a packaged Rooks brings its own Node', () => {
  const message = nodeEngineProblem({ engines: { node: '>=22.5' } }, 'acme-growth', ELECTRON_33);
  assert.ok(message);
  assert.match(message, /`acme-growth` requires Node >=22\.5/);
  assert.match(message, /runs Node 20\.18\.3/);
  assert.match(message, /Electron 33\.4\.11/);
  assert.match(message, /not on the Node installed on this system/);
  assert.equal(nodeEngineProblem({ engines: { node: '>=20' } }, 'acme-growth', ELECTRON_33), null);
});

test('a daemon run from the sources is not told about a packaged runtime', () => {
  const message = nodeEngineProblem({ engines: { node: '>=99' } }, 'acme', { node: '22.11.0', electron: null, packaged: false, source: 'daemon' });
  assert.ok(message);
  assert.match(message, /runs Node 22\.11\.0/);
  assert.doesNotMatch(message, /packaged/);
});

test('a CLI that could not reach the daemon says its answer is an estimate', () => {
  const message = nodeEngineProblem({ engines: { node: '>=99' } }, 'acme', { node: '24.1.0', electron: null, packaged: false, source: 'local' });
  assert.ok(message);
  assert.match(message, /daemon could not be reached/);
});
