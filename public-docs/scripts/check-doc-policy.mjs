// Verifies the publication policy itself: the committed references are clean,
// the guard really fails on a leak, and no rewrite publishes a forbidden term.
// Run with `npm run check:policy`; it reads files and never starts anything.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyRewrites, assertPublishable} from './doc-policy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const policy = JSON.parse(readFileSync(resolve(here, 'doc-policy.json'), 'utf8'));
const failures = [];
const check = (name, run) => {
  try {
    run();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`);
  }
};

for (const file of ['docs/changelog.md', 'docs/usage/cli-reference.md', 'docs/installation/config-reference.md', 'docs/usage/licence-api.md', 'docs/installation/first-run.md']) {
  check(`committed reference is publishable: ${file}`, () => {
    assertPublishable(readFileSync(resolve(site, file), 'utf8'), file);
  });
}

check('the guard rejects a forbidden term', () => {
  let threw = false;
  try {
    assertPublishable('  timon license install <file>   validates then installs the JWT\n', 'sample.md');
  } catch (error) {
    threw = true;
    if (!error.message.includes('doc-policy.json')) throw new Error('Guard message does not point at the policy file');
  }
  if (!threw) throw new Error('A forbidden term passed the guard');
});

check('private site administration cannot enter customer documentation', () => {
  for (const sample of ['timon-site license create', '/api/v1/admin/licenses', 'ADMIN_KEY']) {
    let refused = false;
    try { assertPublishable(sample, 'sample.md'); } catch { refused = true; }
    if (!refused) throw new Error(`Private administration passed the guard: ${sample}`);
  }
});

check('the licence rewrites make that same line publishable', () => {
  const {text} = applyRewrites(
    'Offline license:\n  timon license status                       status, edition and expiration\n'
    + '  timon license install <file>               validates then installs the JWT\n'
    + '  timon license activate <key>               exchanges the key with the license server, then installs the JWT\n',
    'cli',
  );
  assertPublishable(text, 'sample.md');
  for (const expected of ['shows your licence status', 'installs a licence file', 'activates Timon with your licence key']) {
    if (!text.includes(expected)) throw new Error(`Rewritten output lost: ${expected}`);
  }
});

check('no rewrite replacement carries a forbidden term', () => {
  for (const rule of policy.rewrites) assertPublishable(rule.replacement, `doc-policy.json (${rule.pattern})`);
});

if (failures.length) {
  console.error(`\n${failures.length} publication-policy check(s) failed.`);
  process.exit(1);
}
console.log('\nPublication policy verified.');
