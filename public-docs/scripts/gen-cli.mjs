import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyRewrites, assertPublishable, isExcluded, reportUnusedRewrites} from './doc-policy.mjs';
const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(site, '../orchestrator/bin/timon');
const temporaryHome = mkdtempSync(join(tmpdir(), 'timon-docs-cli-'));
try {
  // Only the root help branch is executed. Subcommands may load runtime modules
  // or mutate state even when given --help, so their usage is read as syntax.
  const help = execFileSync('timeout', ['20', process.execPath, binary, '--help'], {
    cwd: site,
    env: {PATH: process.env.PATH, TIMON_HOME: temporaryHome, TIMON_API: 'http://127.0.0.1:1', NO_COLOR: '1'},
    encoding: 'utf8', timeout: 21_000, maxBuffer: 1024 * 1024,
  });
  if (!help.startsWith('timon —')) throw new Error('Unexpected CLI help format');
  const source = readFileSync(binary, 'utf8');
  const syntax = ts.createSourceFile('timon.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function literal(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left), right = literal(node.right);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    return undefined;
  }
  const usages = new Map();
  function walk(node, owner = '') {
    if (ts.isFunctionDeclaration(node)) owner = node.name?.text ?? '';
    if (owner !== 'help' && ts.isCallExpression(node) && node.expression.getText(syntax) === 'process.stderr.write') {
      const value = node.arguments[0] && literal(node.arguments[0]);
      if (value?.includes('usage: timon ')) {
        const line = syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1;
        usages.set(value.trim(), line);
      }
    }
    ts.forEachChild(node, child => walk(child, owner));
  }
  walk(syntax);
  if (usages.size < 20) throw new Error('Usage extraction unexpectedly incomplete');
  // Retain exact command syntax and English explanations; translate the few
  // legacy French help phrases without evaluating source template expressions.
  const translations = new Map([
    ['recherche plein-texte dans l\'historique des missions', 'full-text search in mission history'],
    ['force le rattrapage de l\'index de recherche', 'rebuild the mission search index'],
    ['<texte…>', '<text…>'], ['<url|nom>', '<url|name>'], ['<commande>', '<command>'],
    ['sinon ~/.timon/daemon-token (sous $TIMON_HOME)', 'otherwise ~/.timon/daemon-token (under $TIMON_HOME)'],
    ['mid-chantier', 'during a project'],
    ["Project's embedded browser (NEVER a local Chrome — see system prompt):", "Project's embedded browser:"],
    ['      This is THE way to memorize: writing to pieges.md no longer injects anything.\n', ''],
  ]);
  // A long usage line is cut between two whole arguments, never mid-flag
  // (`[--pro`), and says so.
  const heading = text => {
    if (text.length <= 85) return text;
    let depth = 0, end = 0;
    for (let i = 0; i < 85; i += 1) {
      if (text[i] === '[') depth += 1;
      else if (text[i] === ']') depth -= 1;
      else if (text[i] === ' ' && depth === 0) end = i;
    }
    return `${text.slice(0, end)} …`;
  };
  const english = text => {
    for (const [before, after] of translations) text = text.replaceAll(before, after);
    return text;
  };
  // Publication policy: drop excluded help sections, then rewrite the prose we
  // publish differently from the local help (see scripts/doc-policy.json).
  const sections = english(help).trim().split('\n\n')
    .filter(block => !isExcluded('cliSections', block.trimStart().split('\n')[0].trim()));
  const usedRewrites = new Set();
  const rootHelp = applyRewrites(sections.join('\n\n'), 'cli', usedRewrites);
  let output = `---\ntitle: CLI reference\nsidebar_position: 9\n---\n\n<!-- Generated file. Do not edit by hand. Run npm run gen:cli. -->\n\nRoot help is captured from \`orchestrator/bin/timon --help\` with a disposable \`TIMON_HOME\`, an unreachable API target and a 20-second process limit. No daemon or subcommand is started. Additional usage blocks are read from literal source strings because subcommand help is not universally safe to execute. Legacy French prose is translated and command syntax is retained; descriptions then go through the publication policy in \`scripts/doc-policy.json\`.\n\nThis is a reference snapshot, not a shell script to execute in full. Replace placeholders with real values. Installation, task creation, deletion and service commands change the target instance.\n\n## Root help\n\n\`\`\`text\n${rootHelp.text}\n\`\`\`\n\n## Additional command usage from source\n\nThese blocks supplement the root help (for example pipeline flags). Some commands have no separate usage block. The generator reads them without invoking them.\n`;
  for (const usage of usages.keys()) {
    const command = usage.split('\n')[0].replace('usage: ', '');
    if (isExcluded('cliUsages', command)) continue;
    const title = applyRewrites(command, 'cli', usedRewrites).text;
    output += `\n### ${heading(title.replaceAll('<', '').replaceAll('>', ''))}\n\n\`\`\`text\n${applyRewrites(english(usage), 'cli', usedRewrites).text}\n\`\`\`\n`;
  }
  reportUnusedRewrites(usedRewrites, 'cli');
  assertPublishable(output, 'docs/usage/cli-reference.md');
  writeFileSync(resolve(process.env.TIMON_DOCS_OUT || resolve(site, 'docs'), 'usage/cli-reference.md'), output);
  console.log(`Captured root help and ${usages.size} source usage blocks.`);
} finally {
  rmSync(temporaryHome, {recursive: true, force: true});
}
