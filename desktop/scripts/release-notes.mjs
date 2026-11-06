import { readFileSync } from 'node:fs';

export const CHANGELOG_URL = 'https://docs.timon-ai.com/changelog';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
function versionParts(value) {
  const match = typeof value === 'string' && value.match(versionPattern);
  return match ? [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] === undefined ? null : BigInt(match[4])] : null;
}
function compare(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 4; i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === null) return 1;
    if (right[i] === null) return -1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

// Deliberately only splits level-two headings; Markdown remains opaque text.
export function parseChangelog(markdown) {
  const entries = [];
  let current;
  for (const line of String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^##\s/.test(line)) {
      current = undefined;
      const match = line.match(/^## \[([^\]]+)\](?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?\s*$/);
      if (match && (match[1] === 'Unreleased' || versionParts(match[1]))) {
        current = { version: match[1], date: match[2] ?? null, content: '' };
        entries.push(current);
      }
    } else if (current) current.content += `${line}\n`;
  }
  return entries.map(entry => ({ ...entry, content: entry.content.trim() }));
}

export function createReleaseNotes(markdown, packageVersion) {
  const sections = parseChangelog(markdown);
  const entries = [];
  for (const entry of sections) {
    if (entry.version === 'Unreleased' || !versionParts(packageVersion)
      || compare(entry.version, packageVersion) > 0 || entries.some(item => item.version === entry.version)) continue;
    entries.push({ ...entry, prerelease: entry.version.includes('-rc.'), baseVersion: null });
  }
  entries.sort((a, b) => compare(b.version, a.version));
  const target = versionParts(packageVersion);
  if (target && target[3] !== null) {
    const baseVersion = entries.find(entry => !entry.prerelease && compare(entry.version, packageVersion) < 0)?.version ?? null;
    const existing = entries.find(entry => entry.version === packageVersion);
    if (existing) existing.baseVersion = baseVersion;
    else entries.unshift({ version: packageVersion, date: null,
      content: sections.find(entry => entry.version === 'Unreleased')?.content ?? '',
      prerelease: true, baseVersion });
  }
  return { schemaVersion: 1, packageVersion, changelogUrl: CHANGELOG_URL, entries };
}

export function readReleaseNotes(path) {
  try {
    const notes = JSON.parse(readFileSync(path, 'utf8'));
    if (notes.schemaVersion !== 1 || !versionParts(notes.packageVersion) || !Array.isArray(notes.entries)
      || !notes.entries.every(entry => entry && versionParts(entry.version)
        && (entry.date === null || typeof entry.date === 'string') && typeof entry.content === 'string'
        && typeof entry.prerelease === 'boolean' && (entry.baseVersion === null || versionParts(entry.baseVersion)))) return null;
    return { ...notes, changelogUrl: CHANGELOG_URL };
  } catch { return null; }
}

// An older release's known issues may be fixed by a newer one shown above it:
// only the newest entry says what is still broken.
function withoutKnownIssues(content) {
  return content.replace(/^### Known issues[ \t]*\n[\s\S]*?(?=^###? |(?![\s\S]))/m, '').trim();
}

// An absent boundary still works numerically; an invalid one yields no notes.
// RC snapshots are cumulative, so do not repeat earlier RC snapshots.
export function selectReleaseNotes(notes, fromVersion, toVersion = notes?.packageVersion) {
  if (!notes || !versionParts(fromVersion) || !versionParts(toVersion) || compare(fromVersion, toVersion) >= 0) return [];
  return notes.entries.filter(entry => compare(entry.version, fromVersion) > 0 && compare(entry.version, toVersion) <= 0
    && (!entry.prerelease || entry.version === toVersion)).sort((a, b) => compare(b.version, a.version))
    .map((entry, index) => index === 0 ? entry : { ...entry, content: withoutKnownIssues(entry.content) });
}
