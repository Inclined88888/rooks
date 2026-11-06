import assert from 'node:assert/strict';
import test from 'node:test';
import { forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3';
import { descendantsOf, inheritedOffset, ownOffsetAt, parentsOf, parsePins, reaimAnchors, serializePins, totalOffset } from './graph-pins';

test('stored offsets round-trip, and nothing survives a bad entry', () => {
  const pins = new Map([['timon.coder', { dx: 12.5, dy: -40 }]]);
  assert.deepEqual([...parsePins(serializePins(pins))], [...pins]);
  assert.equal(serializePins(new Map()), null);
  assert.equal(parsePins('{oops').size, 0);
  assert.equal(parsePins('[1,2]').size, 0);
  assert.deepEqual([...parsePins('{"a":{"dx":1,"dy":"2"},"b":{"dx":1,"dy":2},"c":null}')], [['b', { dx: 1, dy: 2 }]]);
});

test('offsets compose down the hierarchy', () => {
  const parentOf = parentsOf([
    { source: 'main', target: 'hub' },
    { source: 'hub', target: 'a' },
    { source: 'a', target: 'a1' },
    { source: 'hub', target: 'b' },
    { source: 'other', target: 'a' },
  ]);
  // First incoming link wins.
  assert.equal(parentOf.get('a'), 'hub');
  const pins = new Map([['hub', { dx: 100, dy: -20 }], ['a', { dx: 5, dy: 5 }]]);
  assert.deepEqual(inheritedOffset('hub', parentOf, pins), { dx: 0, dy: 0 });
  assert.deepEqual(totalOffset('hub', parentOf, pins), { dx: 100, dy: -20 });
  assert.deepEqual(totalOffset('b', parentOf, pins), { dx: 100, dy: -20 });
  assert.deepEqual(totalOffset('a1', parentOf, pins), { dx: 105, dy: -15 });
  // Pinning a child stores only what it adds to its parent's move.
  const up = inheritedOffset('a', parentOf, pins);
  assert.deepEqual(ownOffsetAt(130, 80, { x: 20, y: 90 }, up), { dx: 10, dy: 10 });
});

test('descendants of a node, cycles included', () => {
  const parentOf = parentsOf([
    { source: 'hub', target: 'a' },
    { source: 'a', target: 'a1' },
    { source: 'hub', target: 'b' },
    { source: 'x', target: 'y' },
    { source: 'y', target: 'x' },
  ]);
  assert.deepEqual([...descendantsOf('hub', parentOf)].sort(), ['a', 'a1', 'b']);
  assert.deepEqual([...descendantsOf('b', parentOf)], []);
  assert.deepEqual([...descendantsOf('x', parentOf)], ['y']);
  assert.deepEqual(inheritedOffset('x', parentOf, new Map([['x', { dx: 1, dy: 1 }], ['y', { dx: 2, dy: 2 }]])), { dx: 2, dy: 2 });
});

test('re-aimed anchors pull toward the new target, not the cached one', () => {
  type N = SimulationNodeDatum & { tx: number; ty: number };
  const n: N = { x: 0, y: 0, tx: 0, ty: 0 };
  const ax = (d: N) => d.tx;
  const ay = (d: N) => d.ty;
  const sim = forceSimulation<N>([n]).force('anchorX', forceX<N>(ax).strength(1)).force('anchorY', forceY<N>(ay).strength(1)).stop();
  n.tx = 100;
  n.ty = -50;
  sim.tick(20);
  // forceX/forceY cached the first target: without re-aiming the node stays put.
  assert.ok(Math.abs(n.x ?? NaN) < 1 && Math.abs(n.y ?? NaN) < 1);
  reaimAnchors(sim, ax, ay);
  sim.tick(60);
  assert.ok(Math.abs((n.x ?? NaN) - 100) < 1, `x=${n.x}`);
  assert.ok(Math.abs((n.y ?? NaN) + 50) < 1, `y=${n.y}`);
});
