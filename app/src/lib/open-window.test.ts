import assert from 'node:assert/strict';
import test from 'node:test';
import { canOpenWindows, openInNewWindow } from './open-window';
import { MACHINE_ATTRIBUTE } from './machines/machine-storage';

type Globals = { document?: unknown; window?: unknown };
const g = globalThis as unknown as Globals;

/** A page of `machine` showing `path`, in a desktop window whose bridge answers `answer`. */
function scene(machine: string | undefined, path: string, answer: (request: unknown) => Promise<unknown> = async () => ({ opened: true }),
  desktop = true) {
  const url = new URL(path, 'http://app.test');
  const asked: unknown[] = [];
  g.document = { documentElement: { getAttribute: (name: string) => (name === MACHINE_ATTRIBUTE ? machine ?? null : null) } };
  g.window = {
    location: { pathname: url.pathname, search: url.search, hash: url.hash },
    ...(desktop ? { rooksDesktop: { openWindow: (request: unknown) => { asked.push(request); return answer(request); } } } : {}),
  };
  return asked;
}

test.afterEach(() => {
  delete g.document;
  delete g.window;
});

test('V5: outside the desktop there is no window to open', async () => {
  const asked = scene('vps', '/kanban', undefined, false);
  assert.equal(canOpenWindows(), false);
  assert.equal(await openInNewWindow(), false);
  assert.deepEqual(asked, []);
});

test('V5: the page on screen opens on the machine it was served for, overlay and fragment dropped', async () => {
  const asked = scene('vps', '/chat?agent=coder&mission=m1&settings=machines#end');
  assert.equal(canOpenWindows(), true);
  assert.equal(await openInNewWindow(), true);
  assert.deepEqual(asked, [{ route: '/chat?agent=coder&mission=m1', machineId: 'vps' }]);
});

test('V5: a named route opens; this computer is named too', async () => {
  const asked = scene(undefined, '/');
  assert.equal(await openInNewWindow('/kanban'), true);
  assert.deepEqual(asked, [{ route: '/kanban', machineId: 'local' }]);
});

test('V5: what is not a page of the app never reaches the shell', async () => {
  const asked = scene('vps', '/');
  for (const route of ['https://evil.example/', '//evil.example', '/\\evil.example', '/login', '/api/ui/missions', 'kanban', '/\t/x']) {
    assert.equal(await openInNewWindow(route), false, route);
  }
  assert.deepEqual(asked, []);
});

test('V5: a shell that declines or fails resolves to false', async () => {
  scene('vps', '/kanban', async () => ({ opened: false }));
  assert.equal(await openInNewWindow(), false);
  scene('vps', '/kanban', async () => { throw new Error('Only a Rooks window opens another one.'); });
  assert.equal(await openInNewWindow(), false);
  scene('vps', '/kanban', async () => undefined);
  assert.equal(await openInNewWindow(), false);
});
