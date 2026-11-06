/**
 * Bumps the product version in one gesture, and closes the changelog's
 * `Unreleased` section onto it.
 *
 * Why a script rather than three `npm version` calls: the daemon reports its
 * own version to the licence server as `appVersion` (`timonVersion()` in
 * `orchestrator/src/license/client.ts`, which reads `orchestrator/package.json`),
 * while `desktop/package.json` carries the version of the installer a tester
 * actually downloaded. Bump one without the other and the two halves of the
 * same build declare different versions to the server — with
 * `LICENSE_FREE_MIN_CLIENT_VERSION` able to filter on exactly that value.
 *
 * Writes files and nothing else. Committing and tagging stay a human gesture:
 * a tag is the anchor a release is read from afterwards, and an agent that
 * lays one down by accident is a mess to unwind.
 *
 *   node scripts/bump-version.mjs patch|minor|major|<x.y.z> [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Every package whose version must move as one. `app` holds no version of its
 *  own meaning, but a lone `0.1.0` left behind reads as a bug to the next one
 *  to open it. */
const PACKAGES = ['orchestrator/package.json', 'app/package.json', 'desktop/package.json'];
/** The one the daemon actually reports. Source of the current version. */
const REFERENCE = 'orchestrator/package.json';
const CHANGELOG = 'CHANGELOG.md';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const [target, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

if (!target || flags.some((f) => f !== '--dry-run')) {
  fail('Usage: node scripts/bump-version.mjs patch|minor|major|<x.y.z> [--dry-run]');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function read(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function write(path, content) {
  if (dryRun) return;
  writeFileSync(resolve(ROOT, path), content);
}

function versionOf(source, path) {
  // Read by regex rather than by parsing: writing the file back through
  // JSON.stringify would reformat every line npm wrote, and the diff of a
  // version bump has to stay one line.
  const match = source.match(/"version":\s*"([^"]+)"/);
  if (!match) fail(`no "version" field in ${path}`);
  return match[1];
}

function nextVersion(current, how) {
  if (SEMVER.test(how)) return how;
  const parts = current.match(SEMVER);
  if (!parts) fail(`current version is not x.y.z: ${current}`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return fail(`unknown bump: ${how} (expected patch, minor, major or x.y.z)`);
}

/** Renames `## [Unreleased]` to the released version and reopens an empty
 *  `Unreleased` above it, so the next change has somewhere to land. */
function releaseChangelog(source, version, date) {
  const heading = '## [Unreleased]';
  const at = source.indexOf(heading);
  if (at < 0) fail(`${CHANGELOG} has no "${heading}" section`);

  const body = source.slice(at + heading.length, sectionEnd(source, at + heading.length));
  if (!body.trim()) {
    fail(`${CHANGELOG}: the Unreleased section is empty — a version with nothing to say is a version nobody needs`);
  }
  // `Known issues` are not fixed by the act of releasing: they follow the new
  // version and stay open until something actually repairs them.
  const known = knownIssues(body);
  const reopened = known ? `${heading}\n\n### Known issues\n\n${known}\n` : `${heading}\n`;
  return `${source.slice(0, at)}${reopened}\n## [${version}] — ${date}${source.slice(at + heading.length)}`;
}

function sectionEnd(source, from) {
  const next = source.indexOf('\n## ', from);
  return next < 0 ? source.length : next;
}

function knownIssues(body) {
  const at = body.indexOf('### Known issues');
  if (at < 0) return '';
  const from = at + '### Known issues'.length;
  const next = body.indexOf('\n### ', from);
  return body.slice(from, next < 0 ? body.length : next).replace(/^\n+/, '').replace(/\n+$/, '');
}

const current = versionOf(read(REFERENCE), REFERENCE);
const version = nextVersion(current, target);
const date = new Date().toISOString().slice(0, 10);

for (const path of PACKAGES) {
  const source = read(path);
  const was = versionOf(source, path);
  if (was !== current) {
    console.warn(`  ! ${path} was at ${was}, not ${current} — realigning on ${version}`);
  }
  write(path, source.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
  console.log(`  ${path}: ${was} → ${version}`);
}

write(CHANGELOG, releaseChangelog(read(CHANGELOG), version, date));
console.log(`  ${CHANGELOG}: Unreleased → [${version}] — ${date}`);

console.log(dryRun ? '\nDry run: nothing written.' : `\nWritten. To publish this version:

  git commit -am "chore(release): ${version}"
  git tag v${version}
`);
