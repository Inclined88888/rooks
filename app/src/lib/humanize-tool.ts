/**
 * SAFETY NET, not the main source.
 *
 * The right description of a tool call is the one the AGENT writes itself:
 * Claude Code's `Bash` tool requires a `description` field, present on 100%
 * of the Bash calls measured on a real mission (204/204). It is contextual
 * where a heuristic can only be generic — "Trace the callers of
 * createShipment" rather than "search text in files". So `ToolUse.intent` is
 * what is shown first (see chat-client).
 *
 * This module only covers the gaps:
 *   - the tools WITHOUT a description field (Read, Edit, Write, Grep, MCP…) —
 *     measured: 0/101 carry one;
 *   - the LLM backends that do not provide it. ROOKS must run on something
 *     other than Claude (see CLAUDE.md), and nothing guarantees that field
 *     elsewhere.
 *
 * A generic sentence is better than no sentence. And an unknown pattern falls
 * back on the binary's name rather than inventing a wrong intent.
 *
 * NO LLM HERE: ROOKS forbids itself API calls billed per token.
 */
import { BRAND } from '@/lib/brand';
import { t } from '@/lib/i18n';

/** Last segment of a path, to talk about `panier.tsx` and not
 *  `/home/user/webdev/.../src/components/panier.tsx`. */
function base(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const seg = clean.split('/').filter(Boolean).pop();
  return seg || p;
}

/** Strips the prefixes that carry no intent: `cd X &&`, `sudo`, `time`, the
 *  trailing redirections and the leading env variables. */
function coeurDeCommande(cmd: string): string {
  let c = cmd.trim();
  // Chaining: keep the meaningful link, not the `cd` that introduces it.
  for (let i = 0; i < 4; i++) {
    const m = /^(cd\s+[^&|;]+|[A-Z_]+=[^\s]+|sudo|time|timeout\s+\d+\S*)\s*(?:&&|;)?\s*/.exec(c);
    if (!m || !m[0] || m[0].length === c.length) break;
    c = c.slice(m[0].length).trim();
  }
  // Convenience redirections / pipes at the end of the line.
  c = c.replace(/\s*(2>&1|>\s*\S+|\|\s*(head|tail|cat)\b.*)$/g, '').trim();
  // Container wrapper: in this project, almost EVERYTHING goes through a
  // `docker compose exec -u sail app …`. Keeping the wrapper as the description
  // would say "runs a command in a container" for a migration, a test or a
  // composer install alike — the intent is inside.
  const dex = /^docker\s+(compose\s+)?(-p\s+\S+\s+)?exec\s+((-\w+|--[\w-]+)(\s+\S+)?\s+)*\S+\s+(?<inner>.+)$/.exec(c);
  if (dex?.groups?.inner) c = dex.groups.inner.trim();
  return c;
}

/** Description of a shell command. */
function decrireBash(commande: string): string {
  const c = coeurDeCommande(commande);

  // ── FIRST what stops / destroys ──────────────────────────────────────────
  // These patterns come first because they often quote their target:
  // `pkill -9 -f 'artisan test|phpunit'` contains "phpunit" and would
  // otherwise be described as "runs tests", the exact opposite of the truth.
  if (/\b(kill|pkill|killall)\b/.test(c)) return t('humanizeTool.stopProcess');
  if (/\brm\s+-[rf]/.test(c)) return t('humanizeTool.deleteFiles');

  // ── tests ────────────────────────────────────────────────────────────────
  if (/run-tests-chunked|scripts\/.*test/.test(c)) return t('humanizeTool.fullSuite');
  let m = /\bmake\s+test-only\s+T=(\S+)/.exec(c);
  if (m) {
    const cible = m[1]!;
    if (/\.php$|\.ts$|\.tsx$|Test\b/.test(cible)) return t('humanizeTool.testFile', { name: base(cible) });
    if (cible.startsWith('--filter')) return t('humanizeTool.oneTest');
    return t('humanizeTool.testFolder', { name: base(cible) });
  }
  if (/\bmake\s+test\b/.test(c)) return t('humanizeTool.fullSuite');
  if (/\b(phpunit|pest|vitest|jest|pytest)\b/.test(c)) return t('humanizeTool.tests');
  if (/\bplaywright\b/.test(c)) return t('humanizeTool.e2e');

  // ── quality / build ──────────────────────────────────────────────────────
  if (/\bmake\s+lint\b|\bpint\b|\beslint\b|\bruff\b/.test(c)) return t('humanizeTool.lint');
  if (/\btsc\b|\bnpm run build\b|\byarn build\b|\bnext build\b/.test(c)) return t('humanizeTool.build');
  if (/\b(npm|pnpm|yarn) (install|ci)\b|\bcomposer install\b/.test(c)) return t('humanizeTool.install');

  // ── git ──────────────────────────────────────────────────────────────────
  if (/\bgit\s+commit\b/.test(c)) return t('humanizeTool.commit');
  if (/\bgit\s+merge\b/.test(c)) return t('humanizeTool.merge');
  if (/\bgit\s+push\b/.test(c)) return t('humanizeTool.push');
  if (/\bgit\s+(checkout|switch)\b/.test(c)) return t('humanizeTool.checkout');
  if (/\bgit\s+(status|diff|log|show)\b/.test(c)) return t('humanizeTool.repoState');
  if (/\bgit\s+(add|restore|stash)\b/.test(c)) return t('humanizeTool.stage');

  // ── docker / services ────────────────────────────────────────────────────
  if (/docker\s+compose.*\b(up|build)\b/.test(c)) return t('humanizeTool.composeUp');
  if (/docker\s+compose.*\bdown\b/.test(c)) return t('humanizeTool.composeDown');
  if (/docker\s+(compose\s+)?(exec|run)\b/.test(c)) return t('humanizeTool.containerExec');
  if (/\bdocker\s+logs\b/.test(c)) return t('humanizeTool.containerLogs');
  if (/\bsystemctl\b.*\brestart\b/.test(c)) return t('humanizeTool.restartService');
  if (/\bsystemctl\b/.test(c)) return t('humanizeTool.queryService');

  // ── database / migrations ────────────────────────────────────────────────
  if (/artisan\s+migrate/.test(c)) return t('humanizeTool.migrate');
  if (/artisan\s+db:seed/.test(c)) return t('humanizeTool.seed');
  if (/\bartisan\b/.test(c)) return t('humanizeTool.laravel');
  if (/\b(mysql|psql|sqlite3)\b/.test(c)) return t('humanizeTool.queryDatabase');

  // ── reading / search ─────────────────────────────────────────────────────
  if (/\b(rg|grep|ug)\b/.test(c)) return t('humanizeTool.searchText');
  if (/\bfind\b/.test(c)) return t('humanizeTool.findFiles');
  if (/\b(cat|head|tail|sed -n|less)\b/.test(c)) return t('humanizeTool.readFile');
  if (/\bls\b/.test(c)) return t('humanizeTool.listFolder');
  if (/\bcurl\b|\bwget\b/.test(c)) return t('humanizeTool.queryUrl');

  // ── ROOKS ─────────────────────────────────────────────────────────────────
  if (/\brooks\s+task\b/.test(c)) return t('humanizeTool.kanbanTask');
  if (/\brooks\b/.test(c)) return t('humanizeTool.brandCommand', { brand: BRAND.displayName });

  // Clean degradation: the binary, without inventing an intent.
  const binaire = /^([\w./-]+)/.exec(c)?.[1];
  return binaire ? t('humanizeTool.runNamed', { name: base(binaire) }) : t('humanizeTool.runCommand');
}

/**
 * Short sentence describing the tool call, or `null` when the tool's name is
 * enough on its own (nothing to gain by writing "Reads a file" next to a
 * `Read` already named with its path).
 */
export function humanizeTool(
  name: string | undefined,
  detail: string | undefined,
): string | null {
  if (!name) return null;
  const d = (detail ?? '').trim();

  switch (name) {
    case 'Bash':
      return d ? decrireBash(d) : null;
    case 'Read':
      return d ? t('humanizeTool.readNamed', { name: base(d) }) : t('humanizeTool.readFile');
    case 'Edit':
      return d ? t('humanizeTool.editNamed', { name: base(d) }) : t('humanizeTool.editFile');
    case 'Write':
      return d ? t('humanizeTool.writeNamed', { name: base(d) }) : t('humanizeTool.writeFile');
    case 'NotebookEdit':
      return d ? t('humanizeTool.notebookNamed', { name: base(d) }) : t('humanizeTool.notebook');
    case 'Grep':
      return t('humanizeTool.searchText');
    case 'Glob':
      return t('humanizeTool.findByName');
    case 'WebFetch':
      try { return t('humanizeTool.visitNamed', { name: new URL(d).hostname }); } catch { return t('humanizeTool.visitPage'); }
    case 'WebSearch':
      return t('humanizeTool.webSearch');
    case 'TodoWrite':
      return t('humanizeTool.todos');
    case 'Task':
    case 'Agent':
      return t('humanizeTool.delegate');
    default:
      // MCP tools: `mcp__server__action` → "server: action".
      const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
      if (mcp) return t('humanizeTool.mcp', { server: mcp[1]!.replace(/_/g, ' '), action: mcp[2]!.replace(/_/g, ' ') });
      return null;
  }
}
