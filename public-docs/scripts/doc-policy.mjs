// Publication policy shared by the reference generators.
//
// The generators publish whatever the binary and the schema expose, so a new
// command or configuration key reaches the public site on the next `npm run
// gen` without anyone deciding it should. This module is that decision point:
// declarative exclusions, declarative rewrites, and a forbidden-term guard that
// turns a silent leak into a failed generation.
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(resolve(here, 'doc-policy.json'), 'utf8'));

const rewritesFor = scope => policy.rewrites.filter(rule => rule.scope === scope || rule.scope === 'all');

/** Also returns the patterns that fired, so a stale rule can be reported. */
export function applyRewrites(text, scope, used = new Set()) {
  for (const rule of rewritesFor(scope)) {
    const before = text;
    text = text.replace(new RegExp(rule.pattern, rule.flags ?? 'g'), rule.replacement);
    if (text !== before) used.add(rule.pattern);
  }
  return {text, used};
}

/**
 * `scope` is a key of the policy's `exclude` object. Configuration keys exclude
 * their children; CLI entries match a case-insensitive prefix so a whole help
 * section or command family is one line of policy.
 */
export function isExcluded(scope, value) {
  const entries = policy.exclude[scope];
  if (!entries) throw new Error(`Unknown exclusion scope: ${scope}`);
  return entries.some(entry => scope === 'configKeys'
    ? value === entry || value.startsWith(`${entry}.`)
    : value.toLowerCase().startsWith(entry.toLowerCase()));
}

/** Throws when generated output still carries a term we do not publish. */
export function assertPublishable(text, file) {
  const found = [];
  const lines = text.split('\n');
  for (const rule of policy.forbidden) {
    const expression = new RegExp(rule.pattern, 'i');
    lines.forEach((line, index) => {
      if (expression.test(line)) found.push({rule, line: index + 1, text: line.trim()});
    });
  }
  if (!found.length) return;
  const detail = found.map(({rule, line, text}) => `  ${file}:${line}  /${rule.pattern}/  ${rule.why}\n    ${text}`).join('\n');
  throw new Error(
    `Publication policy: forbidden terms in generated output. Add a rewrite or an exclusion in scripts/doc-policy.json.\n${detail}`,
  );
}

/**
 * Reports rules that matched nothing across a whole generation. Upstream wording
 * may simply have changed; the forbidden-term guard is what blocks publication.
 */
export function reportUnusedRewrites(used, scope) {
  for (const rule of rewritesFor(scope)) {
    if (!used.has(rule.pattern)) console.warn(`Publication policy: rewrite never matched (${scope}): ${rule.pattern}`);
  }
}
