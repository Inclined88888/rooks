/**
 * Chat-side slash commands — expansion of a `/<id> [args]` message.
 *
 * Problem solved: skills are inlined passively in the system prompt
 * ("# Skills you MUST apply"), and the agent often ignores them. Here we give
 * the human an EXPLICIT trigger: typing `/<id>` at the start of their message
 * rewrites that message BEFORE it reaches the agent ("message rewrite", like
 * the Claude Code slash commands) by injecting the procedure into it as an imperative
 * instruction for THIS turn.
 *
 * The expansion now resolves against the unified REGISTRY (`skill-registry.ts`):
 * TIMON skills, global Claude skills, global Claude commands, the PROJECT's
 * skills/commands (according to the mission's `cwd`) and plugins. Three formats:
 *   - `timon` / `claude-skill`: the body of the SKILL.md + the request are inlined.
 *   - `claude-cmd`            : Claude command semantics — substitution of
 *     `$ARGUMENTS`/`$1..$9`, execution of the `` !`cmd` `` blocks (GATED by the
 *     `allowed-tools` frontmatter, with a timeout) and injection of the `@file`s.
 *
 * IMPORTANT: the expansion (and so the possible execution of `` !`cmd` ``) takes
 * place when the message is SENT (handleSpawn / send on the index.ts side), not
 * while typing. The chat's autocomplete popup is purely frontend.
 *
 * Contract:
 *  - The message must START with `/` followed by a valid id (slug, `:` allowed
 *    for the namespaces of plugins/subfolders).
 *  - If the id resolves → message rewritten. Otherwise → message returned UNCHANGED.
 *  - A leading `//` escapes (a single literal `/` kept).
 */
import { exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { composePrompt, type PromptPresentation } from './prompt-presentation.js';
import { listAllSkills, readEntryContent, resolveSkill, type SkillEntry } from './skill-registry.js';

const execAsync = promisify(exec);

// `:` allowed for the namespaces (plugin:cmd, dir:cmd).
const SKILL_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/i;

/** Hard timeout per `` !`cmd` `` block run at expansion (host shell). */
const BASH_TIMEOUT_MS = 30_000;
const BASH_MAX_BUFFER = 1024 * 1024; // 1 MiB of stdout captured per command

/** Retire le front-matter YAML (`--- … ---`) d'un markdown. */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim();
}

export type SlashExpansion = {
  expanded: string;
  /** id of the applied skill, or null if the message was not a recognised slash
   *  command (message returned unchanged). */
  skill: string | null;
  /** Display split of the rewritten message: the inlined procedure is a
   *  collapsed section, the human's request stays visible. Absent when the
   *  message was not rewritten — there is then nothing to collapse. */
  presentation?: PromptPresentation;
};

export type SlashOptions = {
  /** The mission's cwd — resolves the project's skills/commands and serves as
   *  execution cwd for the `` !`cmd` `` blocks. */
  cwd?: string;
};

/** Does the `allowed-tools` frontmatter allow running Bash? */
function bashAllowed(entry: SkillEntry): boolean {
  return (entry.allowed_tools ?? []).some((t) => /^bash\b/i.test(t.trim()));
}

/** Replaces $ARGUMENTS, $1..$9 with the given arguments. */
function substituteArgs(text: string, rest: string): string {
  const args = rest.length ? rest.split(/\s+/) : [];
  return text
    .replace(/\$ARGUMENTS\b/g, rest)
    .replace(/\$([1-9])\b/g, (_m, n) => args[Number(n) - 1] ?? '');
}

/** Runs the `` !`cmd` `` blocks and replaces each with its output. Gated by
 *  `allowed-tools`; otherwise replaced by a note (no execution). */
async function runBashBlocks(text: string, entry: SkillEntry, cwd?: string): Promise<string> {
  const RE = /!`([^`]+)`/g;
  if (!RE.test(text)) return text;
  RE.lastIndex = 0;

  if (!bashAllowed(entry)) {
    console.warn(`[slash] /${entry.id} contains !\`cmd\` blocks but allowed-tools does not allow Bash — not run`);
    return text.replace(RE, (_m, cmd) => `[not run — allowed-tools without Bash: \`${cmd}\`]`);
  }

  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) blocks.push(m[1]!);

  const results = new Map<string, string>();
  for (const cmd of blocks) {
    if (results.has(cmd)) continue;
    try {
      const { stdout } = await execAsync(cmd, {
        cwd: cwd && isAbsolute(cwd) ? cwd : process.cwd(),
        timeout: BASH_TIMEOUT_MS,
        maxBuffer: BASH_MAX_BUFFER,
        shell: '/bin/bash',
      });
      console.log(`[slash] /${entry.id} exec !\`${cmd}\` (cwd=${cwd ?? process.cwd()})`);
      results.set(cmd, stdout.trimEnd());
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; killed?: boolean; message?: string };
      const detail = e.killed ? `timeout >${BASH_TIMEOUT_MS}ms` : (e.stderr || e.message || 'error');
      console.warn(`[slash] /${entry.id} exec !\`${cmd}\` failed: ${detail}`);
      results.set(cmd, (e.stdout?.trimEnd() ? e.stdout.trimEnd() + '\n' : '') + `[exec failed: ${detail}]`);
    }
  }
  return text.replace(RE, (_m, cmd) => results.get(cmd) ?? '');
}

/** Injects the content of the `@file` references (relative to the cwd). Paths
 *  not found are left as they are. */
function injectFileRefs(text: string, cwd?: string): string {
  return text.replace(/(^|\s)@([^\s`]+)/g, (full, pre, ref) => {
    const base = cwd && isAbsolute(cwd) ? cwd : process.cwd();
    const abs = isAbsolute(ref) ? ref : join(base, ref);
    if (!existsSync(abs)) return full;
    try {
      const body = readFileSync(abs, 'utf8');
      return `${pre}\n\n<file path="${ref}">\n${body}\n</file>\n`;
    } catch {
      return full;
    }
  });
}

/**
 * Rewrites a chat message if it is a `/<id> [args]` slash command.
 * Always returns a usable message (unchanged if not recognised).
 */
export async function expandSlashCommand(
  message: string, opts: SlashOptions = {},
): Promise<SlashExpansion> {
  if (typeof message !== 'string' || message.length === 0 || message[0] !== '/') {
    return { expanded: message, skill: null };
  }
  // `//` escape → a literal slash, no command.
  if (message.startsWith('//')) {
    return { expanded: message.slice(1), skill: null };
  }

  // First token = id; the rest (even multi-line) = the request/arguments.
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(message);
  if (!m) return { expanded: message, skill: null };
  const id = m[1]!;
  const rest = m[2]!.trim();

  if (!SKILL_ID_RE.test(id)) return { expanded: message, skill: null };

  const entry = resolveSkill(id, { cwd: opts.cwd });
  if (!entry) {
    const known = listAllSkills({ cwd: opts.cwd }).filter((e) => !e.shadowed).map((e) => e.id);
    console.warn(`[slash] /${id} ignored — unknown id. Available: ${known.join(', ') || '(none)'}`);
    return { expanded: message, skill: null };
  }

  const raw = readEntryContent(entry);
  if (raw == null) {
    console.warn(`[slash] /${id} not found on disk (${entry.path}) — message unchanged`);
    return { expanded: message, skill: null };
  }
  const body = stripFrontmatter(raw);

  let composed: { text: string; presentation: PromptPresentation };
  if (entry.format === 'claude-cmd') {
    // Claude command semantics: args → !bash → @files.
    let processed = substituteArgs(body, rest);
    processed = await runBashBlocks(processed, entry, opts.cwd);
    processed = injectFileRefs(processed, opts.cwd);
    composed = composePrompt([{
      kind: 'instruction',
      label: 'commandInvoked',
      labelVars: { id },
      text: [
        `[Claude command invoked: \`/${id}\`] Run the procedure below (the \`!\` blocks and \`@\` files are already resolved). This is the priority instruction of this turn.`,
        ``,
        `<command id="${id}">`,
        processed,
        `</command>`,
      ].join('\n'),
    }]);
  } else {
    // TIMON skill or Claude skill: the body + the request are inlined.
    const demande = rest
      ? `My request: ${rest}`
      : `My request: apply this skill to the current context of the conversation.`;
    // The inlined procedure runs to hundreds of lines: it goes into a
    // collapsed section, and only the human's request stays visible in their
    // bubble. Both parts concatenated give back the message word for word —
    // an invariant the client checks before applying the presentation.
    composed = composePrompt([
      {
        kind: 'instruction',
        label: 'skillInvoked',
        labelVars: { id },
        text: [
          `[Skill invoked explicitly: \`${id}\`] Apply the skill procedure below to my request, STRICTLY. This is not optional — it is the priority instruction of this turn.`,
          ``,
          `<skill id="${id}">`,
          body,
          `</skill>`,
          ``,
          `---`,
          ``,
        ].join('\n'),
      },
      { kind: 'text', text: demande },
    ]);
  }

  return { expanded: composed.text, skill: id, presentation: composed.presentation };
}
