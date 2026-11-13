export interface ReleaseNote { version: string; date: string | null; content: string; prerelease: boolean; baseVersion: string | null }
export interface ReleaseNotes { schemaVersion: 1; packageVersion: string; changelogUrl: string; entries: ReleaseNote[] }
export const CHANGELOG_URL: string;
export function parseChangelog(markdown: string): Pick<ReleaseNote, 'version' | 'date' | 'content'>[];
export function createReleaseNotes(markdown: string, packageVersion: string): ReleaseNotes;
export function readReleaseNotes(path: string): ReleaseNotes | null;
export function selectReleaseNotes(notes: ReleaseNotes | null, fromVersion: string, toVersion?: string): ReleaseNote[];
