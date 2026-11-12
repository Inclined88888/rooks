// The `npm-script` rule of check-portability.mjs, apart so that a test can import
// it: that script runs its check as soon as it is loaded.
//
// JSON has no comment to carry an opt-out: what cmd.exe cannot run belongs in a
// `node scripts/….mjs`, which runs the same everywhere.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const PACKAGES = ['app', 'orchestrator', 'desktop', 'packages/sdk', 'public-docs'];
const PARENTS = ['plugins', 'examples', 'orchestrator/official-providers'];
const UNIX_COMMAND = /^(rm|cp|mv|mkdir|touch|ln|chmod|chown|cat|sed|awk|grep|ls|head|tail|which|whoami|ps|pgrep|pkill|kill|sh|bash|systemctl|launchctl|open|xdg-open|export|env|source)(\s|$)/;

/**
 * Why cmd.exe, the shell npm uses on Windows, would not run this npm script;
 * null if it would. `&&`, `||` and `|` mean the same there and stay allowed.
 */
export function npmScriptProblem(script) {
  if (/\$[\w({]|`/.test(script)) return 'shell expansion ($VAR, $(…), backticks)';
  if (script.includes(';')) return '";" does not separate commands';
  if (script.includes("'")) return 'single quotes are not quotes';
  for (const command of script.split(/&&|\|\||\|/).map((part) => part.trim())) {
    const first = command.split(/\s/)[0];
    if (/^\w+=/.test(command)) return `env assignment "${first}" before a command`;
    if (UNIX_COMMAND.test(command)) return `Unix command "${first}"`;
    if (/^\.{1,2}[\\/]/.test(command)) return 'a command run by its relative path';
  }
  return null;
}

/** Is this repo-relative path, with `/` or the OS separator, a manifest the gate reads? */
export function isCheckedManifest(rel) {
  const path = rel.split(sep).join('/');
  if (!path.endsWith('/package.json')) return false;
  const dir = path.slice(0, -'/package.json'.length);
  return PACKAGES.includes(dir) || PARENTS.includes(dirname(dir));
}

/** Repo-relative manifests the gate reads, those present in this checkout. */
export function checkedManifests(root) {
  const children = PARENTS.flatMap((parent) => {
    const abs = join(root, parent);
    return existsSync(abs) ? readdirSync(abs).map((name) => join(parent, name)) : [];
  });
  return [...PACKAGES, ...children]
    .map((dir) => join(dir, 'package.json'))
    .filter((rel) => existsSync(join(root, rel)));
}
