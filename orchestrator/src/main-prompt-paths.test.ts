import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { defaultMainPrompt, exampleProjectCwd } = await import('./agent.js');
const { AGENTS_DIR } = await import('./paths.js');

const agentsDir = join('injected-home', 'agents');

const CASES = [
  { platform: 'win32', cwd: 'C:\\Users\\<user>\\projects\\<slug>', json: 'C:\\\\Users\\\\<user>\\\\projects\\\\<slug>' },
  { platform: 'darwin', cwd: '/Users/<user>/webdev/projects/<slug>', json: '/Users/<user>/webdev/projects/<slug>' },
  { platform: 'linux', cwd: '/home/<user>/webdev/projects/<slug>', json: '/home/<user>/webdev/projects/<slug>' },
] as const;

for (const c of CASES) {
  test(`main prompt on ${c.platform}: real agents dir, OS-native cwd example`, () => {
    const prompt = defaultMainPrompt({ agentsDir, platform: c.platform });
    assert.equal(exampleProjectCwd(c.platform), c.cwd);
    assert.ok(prompt.includes(join(agentsDir, '<name>')));
    assert.ok(prompt.includes(`"cwd": "${c.json}"`));
    assert.ok(prompt.includes(`--cwd "${c.cwd}"`));
    assert.ok(!prompt.includes('~/.timon'));
    assert.ok(!prompt.includes('$HOME'));
    for (const other of CASES.filter((o) => o.platform !== c.platform)) {
      assert.ok(!prompt.includes(other.cwd), `${other.cwd} leaked into the ${c.platform} prompt`);
    }
  });
}

test('main prompt defaults to this installation agents dir', () => {
  assert.ok(defaultMainPrompt().includes(join(AGENTS_DIR, '<name>')));
});
