import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseChangelog } from '../../desktop/scripts/release-notes.mjs';
import { assertPublishable } from './doc-policy.mjs';

export function renderChangelog(markdown) {
  const sections = parseChangelog(markdown).filter(entry => entry.version !== 'Unreleased' && !entry.version.includes('-'));
  const body = sections.map(entry => `## ${entry.version}${entry.date ? ` — ${entry.date}` : ''}\n\n${entry.content}`).join('\n\n');
  const page = `---\ntitle: Changelog\nslug: /changelog\n---\n\n<!-- Generated from CHANGELOG.md. Do not edit. -->\n\nPublished Rooks releases. Preview changes are shown in the app when you install a release candidate.\n\n${body || 'No published release notes are available yet.'}\n`;
  assertPublishable(page, 'changelog.md');
  return page;
}
export function generateChangelog() {
  let markdown = '';
  try { markdown = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'); } catch { /* Notes are optional. */ }
  writeFileSync(new URL('../docs/changelog.md', import.meta.url), renderChangelog(markdown));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) generateChangelog();
