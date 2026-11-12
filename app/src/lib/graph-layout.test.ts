import assert from 'node:assert/strict';
import test from 'node:test';
import { FAN_ARC, FAN_CLAIM, framesOf, layoutForest, LEVEL, NODE_CLAIM, type LayoutLink } from './graph-layout';

const opts = { scale: 1, cx: 0, cy: 0 };

function minDistance(pos: Map<string, { x: number; y: number }>): number {
  const pts = [...pos.values()];
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
    }
  }
  return min;
}

/** A hub with `leads` leads, each carrying `roles` role agents. */
function workspace(hub: string, leads: number, roles: number) {
  const ids = [hub];
  const links: LayoutLink[] = [];
  for (let i = 0; i < leads; i++) {
    const lead = `${hub}.p${i}`;
    ids.push(lead);
    links.push({ source: hub, target: lead });
    for (let j = 0; j < roles; j++) {
      ids.push(`${lead}.r${j}`);
      links.push({ source: lead, target: `${lead}.r${j}` });
    }
  }
  return { ids, links };
}

test('a crowded hub spreads its leads instead of piling them up', () => {
  // The screenshot that prompted this: one workspace with ~15 projects of 4
  // roles each, beside smaller workspaces and lone agents.
  const a = workspace('perso', 15, 4);
  const b = workspace('client', 6, 3);
  const c = workspace('trading', 2, 4);
  const ids = [...a.ids, ...b.ids, ...c.ids, 'main', 'solo1', 'solo2'];
  const pos = layoutForest(ids, [...a.links, ...b.links, ...c.links], opts);
  assert.equal(pos.size, ids.length);
  assert.ok(minDistance(pos) > 2 * FAN_CLAIM - 1e-6, `min distance ${minDistance(pos)}`);
});

test('the rest length of a link is the actual seed distance', () => {
  const w = workspace('hub', 5, 3);
  const pos = layoutForest(w.ids, w.links, opts);
  for (const l of w.links) {
    const s = pos.get(l.source)!;
    const t = pos.get(l.target)!;
    assert.ok(Math.abs(Math.hypot(s.x - t.x, s.y - t.y) - t.parentDistance!) < 1e-6);
    assert.equal(t.root, 'hub');
  }
  assert.equal(pos.get('hub')!.parentDistance, null);
});

test('the main agent sits in the centre, otherwise the largest constellation', () => {
  const w = workspace('big', 3, 2);
  const pos = layoutForest([...w.ids, 'main'], w.links, { ...opts, cx: 10, cy: 20 });
  assert.deepEqual([pos.get('big')!.x, pos.get('big')!.y], [10, 20]);
  const main = layoutForest([...w.ids, 'main'], w.links, { ...opts, cx: 10, cy: 20, preferCenter: 'main' });
  assert.deepEqual([main.get('main')!.x, main.get('main')!.y], [10, 20]);
});

test('children of unequal size on a root ring never overlap', () => {
  // One big subtree beside lone agents: the regression was children placed at
  // the start of their slot instead of its middle.
  const w = workspace('lead', 1, 6);
  const ids = ['root', ...w.ids, 'a', 'b', 'c'];
  const links = [...w.links, ...['lead', 'a', 'b', 'c'].map((t) => ({ source: 'root', target: t }))];
  assert.ok(minDistance(layoutForest(ids, links, opts)) > 2 * FAN_CLAIM - 1e-6);
});

test('a reports_to cycle and dangling links still place every node', () => {
  const pos = layoutForest(['a', 'b', 'c', 'd'], [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'a' },
    { source: 'c', target: 'c' },
    { source: 'ghost', target: 'd' },
  ], opts);
  assert.equal(pos.size, 4);
  for (const p of pos.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.ok(minDistance(pos) > 2 * FAN_CLAIM - 1e-6);
});

test('every depth of a constellation sits on one ring', () => {
  // Three levels of rings: a hub, its poles, their (folded) projects.
  const ids = ['hub'];
  const links: LayoutLink[] = [];
  for (let i = 0; i < 3; i++) {
    ids.push(`p${i}`);
    links.push({ source: 'hub', target: `p${i}` });
    for (let j = 0; j < 4; j++) {
      ids.push(`p${i}.l${j}`);
      links.push({ source: `p${i}`, target: `p${i}.l${j}` });
      ids.push(`p${i}.l${j}.x`);
      links.push({ source: `p${i}.l${j}`, target: `p${i}.l${j}.x` });
    }
  }
  const pos = layoutForest(ids, links, opts);
  const hub = pos.get('hub')!;
  const radius = (id: string) => Math.hypot(pos.get(id)!.x - hub.x, pos.get(id)!.y - hub.y);
  const poles = ids.filter((id) => /^p\d$/.test(id)).map(radius);
  const leads = ids.filter((id) => /^p\d\.l\d$/.test(id)).map(radius);
  for (const r of poles) assert.ok(Math.abs(r - poles[0]!) < 1e-6);
  for (const r of leads) assert.ok(Math.abs(r - leads[0]!) < 1e-6);
  assert.ok(leads[0]! - poles[0]! >= LEVEL - 1e-6);
  assert.ok(minDistance(pos) > 2 * FAN_CLAIM - 1e-6, `min distance ${minDistance(pos)}`);
});

test('an unfolded project fans its roles out close to it, never all around', () => {
  // One project unfolded among six folded ones: its roles stay one step
  // away from it, on an arc that does not close into a flower.
  const ids = ['pole'];
  const links: LayoutLink[] = [];
  for (let i = 0; i < 6; i++) {
    ids.push(`p${i}`);
    links.push({ source: 'pole', target: `p${i}` });
  }
  for (let j = 0; j < 5; j++) {
    ids.push(`p0.r${j}`);
    links.push({ source: 'p0', target: `p0.r${j}` });
  }
  const pos = layoutForest(ids, links, opts);
  const lead = pos.get('p0')!;
  const pole = pos.get('pole')!;
  assert.ok(lead.parentDistance! <= 2 * LEVEL, `pole → project ${lead.parentDistance}`);
  const angles = [0, 1, 2, 3, 4].map((j) => {
    const r = pos.get(`p0.r${j}`)!;
    assert.ok(r.parentDistance! <= 1.5 * LEVEL, `project → role ${r.parentDistance}`);
    return Math.atan2(r.y - lead.y, r.x - lead.x);
  });
  // Every role sits within FAN_ARC / 2 of the outward direction.
  const out = Math.atan2(lead.y - pole.y, lead.x - pole.x);
  for (const a of angles) {
    const off = Math.abs(Math.atan2(Math.sin(a - out), Math.cos(a - out)));
    assert.ok(off <= FAN_ARC / 2 + 1e-6, `role at ${off} rad from outward`);
  }
  // Roles huddle round their project, and keep their claim plus a full one
  // from the others.
  for (let j = 0; j < 5; j++) {
    const r = pos.get(`p0.r${j}`)!;
    for (const id of ids.filter((x) => !x.startsWith('p0'))) {
      const o = pos.get(id)!;
      assert.ok(Math.hypot(r.x - o.x, r.y - o.y) >= NODE_CLAIM + FAN_CLAIM - 1e-6, `p0.r${j} too close to ${id}`);
    }
  }
  assert.ok(minDistance(pos) > 2 * FAN_CLAIM - 1e-6, `min distance ${minDistance(pos)}`);
});

test('the layout is deterministic', () => {
  const w = workspace('hub', 7, 4);
  const one = layoutForest(w.ids, w.links, opts);
  const two = layoutForest([...w.ids].reverse(), [...w.links].reverse(), opts);
  for (const id of w.ids) assert.deepEqual(one.get(id), two.get(id));
});

test('unfolding a project leaves its constellation where it was', () => {
  // Several constellations; the smallest one gets a project unfolded, which
  // made it outrank its neighbours and repack elsewhere.
  const big = workspace('big', 6, 0);
  const mid = workspace('mid', 4, 0);
  const small = workspace('small', 2, 0);
  const ids = [...big.ids, ...mid.ids, ...small.ids, 'main'];
  const links = [...big.links, ...mid.links, ...small.links];
  const before = layoutForest(ids, links, { ...opts, preferCenter: 'main' });
  const roles = ['small.p0.r0', 'small.p0.r1', 'small.p0.r2', 'small.p0.r3', 'small.p0.r4'];
  const after = layoutForest(
    [...ids, ...roles],
    [...links, ...roles.map((r) => ({ source: 'small.p0', target: r }))],
    { ...opts, preferCenter: 'main', previous: framesOf(before) },
  );
  assert.deepEqual([after.get('small')!.x, after.get('small')!.y], [before.get('small')!.x, before.get('small')!.y]);
  // Neighbours made room: no two constellations overlap.
  const frames = [...framesOf(after).values()];
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const a = frames[i]!;
      const b = frames[j]!;
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1e-6);
    }
  }
  assert.ok(minDistance(after) > 2 * FAN_CLAIM - 1e-6, `min distance ${minDistance(after)}`);
});

test('unfolding a project lengthens its branch only, never its siblings\'', () => {
  // The screenshot: a hub with seven projects, one of them unfolded.
  const folded = workspace('hub', 7, 0);
  const roles = ['hub.p3.r0', 'hub.p3.r1', 'hub.p3.r2', 'hub.p3.r3', 'hub.p3.r4'];
  const before = layoutForest(folded.ids, folded.links, opts);
  const after = layoutForest(
    [...folded.ids, ...roles],
    [...folded.links, ...roles.map((r) => ({ source: 'hub.p3', target: r }))],
    opts,
  );
  const rel = (pos: typeof before, id: string) => {
    const hub = pos.get('hub')!;
    const p = pos.get(id)!;
    return [p.x - hub.x, p.y - hub.y];
  };
  for (let i = 0; i < 7; i++) {
    if (i === 3) continue;
    const [bx, by] = rel(before, `hub.p${i}`);
    const [ax, ay] = rel(after, `hub.p${i}`);
    assert.ok(Math.hypot(ax! - bx!, ay! - by!) < 1e-6, `hub.p${i} moved`);
  }
  assert.ok(after.get('hub.p3')!.parentDistance! > before.get('hub.p3')!.parentDistance!);
  assert.ok(minDistance(after) > 2 * FAN_CLAIM - 1e-6, `min distance ${minDistance(after)}`);
});
