#!/usr/bin/env node
/**
 * scaffold-agent — create one ROOKS agent on disk (bind-mount path).
 *
 * Usage:
 *   node tools/scaffold-agent.mjs \
 *     --name initech \
 *     --cwd /workspace/projects/acme \
 *     --project initech \
 *     --role lead             # or 'coder' — picks a default system prompt
 *     [--model sonnet] [--mode auto] [--skills rooks-delegate,git-style]
 *     [--force]               # overwrite if it already exists
 *
 * Files written to ~/.rooks/agents/<name>/{system-prompt.md, config.json}.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = Object.create(null);
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[k] = true;
    } else {
      args[k] = next;
      i++;
    }
  }
}

const name = args.name;
const cwd = args.cwd;
const project = args.project || null;
const role = args.role || 'lead'; // 'lead' or 'coder'
const model = args.model || 'sonnet';
const mode = args.mode || 'auto';
const skills = typeof args.skills === 'string' ? args.skills.split(',').filter(Boolean) : [];
// claude's `auto` mode pre-approves safe commands but blocks unknown
// binaries (like our `rooks` CLI) in --print mode, where there's no human
// to confirm. We pre-approve only the patterns leads need, instead of
// granting blanket bypass:
//   - `Bash(rooks *)` / `Bash(rooks:*)` : the Rooks CLI itself
//   - `Bash(jq *)`                      : agents lean on jq to parse rooks JSON
// Everything else still follows the agent's permission_mode.
const allowedTools = typeof args['allowed-tools'] === 'string'
  ? args['allowed-tools'].split(',').filter(Boolean)
  : (role === 'lead' && skills.includes('rooks-delegate'))
    ? ['Bash(rooks *)', 'Bash(rooks:*)', 'Bash(jq *)']
    : [];
const force = !!args.force;

if (!name || !cwd) {
  console.error('usage: scaffold-agent --name <slug> --cwd </workspace/...> [--project <slug>] [--role lead|coder] ...');
  process.exit(64);
}
if (!/^[A-Za-z0-9._-]+$/.test(name)) {
  console.error(`bad name "${name}" — must match [A-Za-z0-9._-]+`);
  process.exit(64);
}

const ROOKS_HOME = process.env.ROOKS_HOME || join(homedir(), '.rooks');
const dir = join(ROOKS_HOME, 'agents', name);

if (existsSync(dir) && !force) {
  console.error(`agent "${name}" already exists at ${dir}. Use --force to overwrite.`);
  process.exit(1);
}

const projectLabel = project || '(no project)';
const promptLead = `You are \`${name}\`, the orchestrator of the project **${projectLabel}**.

## Context
- Your cwd is \`${cwd}\` (= \`~/webdev${cwd.replace('/workspace', '')}\` on the host).
- You coordinate the project's sub-agents (typically \`${name}.coder\`, \`${name}.review\`, etc. — use \`rooks list\` to find out who exists).
- For any concrete task (reading, editing, tests), **delegate** with \`rooks spawn <agent>\` rather than doing the work yourself.

## Style
- Concise. No needless final recap.
- When you delegate: \`→ delegated to <agent> (mission <8 chars>)\`.
- When you finish: \`→ done.\` or \`→ blocked: <reason>\`.

## Hard rules
- Never work across projects without the user's explicit permission.
- NEVER write a "Claude", "Anthropic" or "Co-Authored-By" mention in commits.
- Answer in the user's language.
`;

const promptCoder = `You are \`${name}\`, the code/editing executor of the project **${projectLabel}**.

## Context
- Your cwd is \`${cwd}\` (= \`~/webdev${cwd.replace('/workspace', '')}\` on the host).
- You receive missions from \`${(name || '').split('.')[0]}\` (the project lead) or directly from the user.

## Style
- Concise.
- No final recap: do the job and hand back with a short status.

## Hard rules
- Do not leave the cwd. If asked for something outside it, refuse and say why.
- No "Claude" / "Anthropic" / "Co-Authored-By" mention in commits.
- Answer in the user's language.
`;

const systemPrompt = role === 'coder' ? promptCoder : promptLead;

const config = {
  cwd,
  ...(project ? { project } : {}),
  model,
  permission_mode: mode,
  ...(skills.length ? { skills } : {}),
  ...(allowedTools.length ? { allowed_tools: allowedTools } : {}),
};

mkdirSync(join(dir, 'memory'), { recursive: true });
writeFileSync(join(dir, 'system-prompt.md'), systemPrompt);
writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');

console.log(`✓ scaffolded ${name} at ${dir}`);
console.log(`  cwd=${cwd} project=${projectLabel} role=${role} model=${model}`);
if (skills.length) console.log(`  skills=${skills.join(',')}`);
